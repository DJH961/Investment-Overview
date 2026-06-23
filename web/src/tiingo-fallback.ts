/**
 * Web Tiingo-fallback orchestration — the wiring layer that runs *after* the
 * Twelve Data (primary) pass in a refresh and decides, per the shared gate in
 * `tiingo-gate.ts`, whether to spend any Tiingo calls to fill what the primary
 * missed. It owns the I/O the pure gate deliberately avoids: reading/writing the
 * ET-reset Tiingo budget + canary state, fetching via the `/price` Worker proxy,
 * and merging results back into the quote map.
 *
 * It engages for two situations (see `docs/tiingo_fallback_plan.md` §Web design):
 *   (a) symbols Twelve Data left **missing/stale** (including the FSKAX-style
 *       upstream gap where the primary serves a too-old bar), and
 *   (b) the **over-quota / 429** case where the free-tier budget is spent.
 * NAV funds take the **peer-confirmation + canary** path so a late NAV cycle
 * costs at most one canary probe before fetching confirmed laggards.
 */

import {
  readTiingoCreditLog,
  readTiingoState,
  readTiingoNoNewer,
  recordNavPublish,
  recordTiingoCredits,
  recordTiingoNoNewer,
  clearTiingoNoNewer,
  creditsSpentThisHour,
  tiingoCreditsSpentToday,
  writeCachedQuotes,
  writeTiingoState,
  type StorageLike,
  type TiingoState,
} from "./cache";
import { isUsMarketOpen, latestSettledSessionDate } from "./market-hours";
import { PriceError, type FetchLike, type Quote } from "./prices";
import type { QuoteLoadReport } from "./quotes";
import { fetchTiingoQuotes } from "./tiingo";
import {
  Budget,
  decideNav,
  etMinutesOfDay,
  firstProbeMinutes,
  marketSymbolEligible,
  navCooldownFor,
  selectWithinBudget,
  NAV_MAX_PROBES_PER_DAY,
  WEB_DAILY_CAP,
  WEB_HOURLY_CAP,
} from "./tiingo-gate";

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a backup "nothing newer" result suppresses re-pulling the same
 * symbol. Once Tiingo confirms it holds nothing fresher than what we already
 * have for the target date, there is no point spending another credit on it
 * every time the user taps Refresh — a genuinely behind mutual fund won't gain a
 * new NAV within the hour. A newer target date (next session / NAV cycle) lifts
 * the suppression immediately regardless of this cooldown.
 */
export const TIINGO_NO_NEWER_COOLDOWN_MS = HOUR_MS;

/** The Tiingo budget consumed so far, surfaced for the usage overview. */
export interface TiingoBudgetView {
  hourUsed: number;
  hourLimit: number;
  dayUsed: number;
  dayLimit: number;
}

export interface TiingoFallbackResult {
  /** The merged quote map (Tiingo values folded into the Twelve Data result). */
  quotes: Map<string, Quote>;
  /** Symbols whose price now comes from the Tiingo fallback this cycle. */
  tiingoSymbols: string[];
  /** Tiingo budget used so far, for the hourly/daily usage overview. */
  budget: TiingoBudgetView;
  /** A transient Tiingo failure, if any (never fatal — the primary still stands). */
  error: PriceError | null;
}

export interface TiingoFallbackOptions {
  symbols: string[];
  navSymbols: ReadonlySet<string>;
  /** The quote map produced by the Twelve Data pass (mutated copy is returned). */
  quotes: Map<string, Quote>;
  report: QuoteLoadReport;
  /** The resolved `/price` Worker URL, or null when the fallback isn't configured. */
  proxyUrl: string | null;
  now?: number;
  storage?: StorageLike | null;
  fetchImpl?: FetchLike;
  /**
   * A manual "Refresh via Tiingo now": bypasses the canary first-probe-time and
   * cooldown *timing* gates (so a user tap can probe immediately), but still
   * enforces the smart gates (newer data must exist) and the hard budget caps.
   */
  manual?: boolean;
  /**
   * A manual "route everything through the backup provider" pull (Settings →
   * "Try the backup data provider now"): fetch *every* still-behind holding from
   * Tiingo directly, skipping the NAV canary/peer *timing* gates so missing funds
   * are pulled at once rather than one canary probe at a time. The "unless the
   * data is recent" rule and the hard budget caps still apply — symbols whose
   * held value already covers the latest settled session are left untouched.
   */
  forceAll?: boolean;
  /**
   * Hold back this many Tiingo credits from every budget check in this run (the
   * startup quick-refresh sets it so a true gap-fill fallback later in the
   * session keeps some headroom). Defaults to 0 — normal fallbacks may spend the
   * full self-capped budget.
   */
  reserveCredits?: number;
  /** Last-known EUR size per symbol, used only to pick the largest as canary. */
  sizeForSymbol?: (symbol: string) => number;
}

/**
 * Snapshot the current Tiingo budget from the persisted credit log. `reserve`
 * shaves that many credits off both the hourly and daily caps, so the budget's
 * `remaining()` keeps a headroom the caller will not spend (used by the startup
 * quick-refresh, which must never burn the last few Tiingo credits).
 */
function readBudget(
  now: number,
  storage: StorageLike | null | undefined,
  reserve = 0,
): Budget {
  const log = readTiingoCreditLog(now, undefined, storage ?? undefined);
  // The hourly cap resets on the clock hour (1:00, 2:00, …) rather than a
  // trailing 60-min window, so a burst at :55 doesn't suppress the fresh
  // allowance the user expects at the top of the next hour.
  const hourUsed = creditsSpentThisHour(log, now);
  const dayUsed = tiingoCreditsSpentToday(log, now);
  return new Budget(
    hourUsed,
    dayUsed,
    Math.max(0, WEB_HOURLY_CAP - reserve),
    Math.max(0, WEB_DAILY_CAP - reserve),
  );
}

/** The Tiingo credits still spendable right now (min of the hour/day windows). */
export function tiingoRemainingCredits(now: number, storage?: StorageLike | null): number {
  return readBudget(now, storage).remaining();
}

function budgetView(now: number, storage: StorageLike | null | undefined): TiingoBudgetView {
  const b = readBudget(now, storage);
  return { hourUsed: b.hourUsed, hourLimit: b.hourlyCap, dayUsed: b.dayUsed, dayLimit: b.dailyCap };
}

/** The ET calendar day (`YYYY-MM-DD`) for the canary counter's reset key. */
function etDay(now: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Fetch `batch` via Tiingo, merge priced results into `quotes` + the cache, note
 * NAV value-date advances, and record the budget spend. Returns the symbols that
 * actually gained a Tiingo-sourced price.
 *
 * Also maintains the per-symbol "nothing newer" stamps (see
 * {@link recordTiingoNoNewer}): a symbol whose held value-date *advanced* clears
 * its stamp, while a symbol the backup left no fresher than before is stamped
 * against `expected` so the next refresh doesn't re-pull the same stale value.
 */
async function fetchAndMerge(
  batch: string[],
  opts: {
    proxyUrl: string;
    navSymbols: ReadonlySet<string>;
    quotes: Map<string, Quote>;
    expected: string;
    marketOpen: boolean;
    now: number;
    storage: StorageLike | null | undefined;
    fetchImpl?: FetchLike;
  },
): Promise<string[]> {
  if (batch.length === 0) return [];
  // Snapshot the value-date we held *before* the merge, per symbol, so we can
  // tell afterwards whether the backup actually advanced it.
  const priorVdFor = new Map<string, string | null>();
  for (const symbol of batch) priorVdFor.set(symbol, opts.quotes.get(symbol)?.valueDate ?? null);
  // Reserve the budget up-front (same discipline as the Twelve Data path), so a
  // failed call still counts against the self-cap rather than allowing a retry storm.
  recordTiingoCredits(batch.length, opts.now, opts.storage ?? undefined);
  const fetched = await fetchTiingoQuotes(batch, opts.proxyUrl, {
    fetchImpl: opts.fetchImpl,
    navSymbols: opts.navSymbols,
  });
  const priced = new Map<string, Quote>();
  const gained: string[] = [];
  for (const symbol of batch) {
    const q = fetched.get(symbol);
    if (!q || q.price === null) continue;
    const stamped: Quote = { ...q, at: opts.now };
    const prev = opts.quotes.get(symbol);
    // Don't let Tiingo overwrite a *fresher* primary value: only take it when it
    // fills a gap or carries a not-older value-date than what we already hold.
    const prevVd = prev?.valueDate ?? null;
    // Loose `!= null` is deliberate: `q.valueDate` may be null *or* undefined
    // here, and both mean "no value-date", so neither should overwrite.
    if (prev && prev.price !== null && prevVd !== null && q.valueDate != null && q.valueDate < prevVd) {
      continue;
    }
    priced.set(symbol, stamped);
    opts.quotes.set(symbol, stamped);
    gained.push(symbol);
    if (opts.navSymbols.has(symbol) && q.valueDate) {
      const prior = prevVd;
      if (!prior || q.valueDate > prior) recordNavPublish(symbol, q.valueDate, opts.now, opts.storage ?? undefined);
    }
  }
  if (priced.size > 0) writeCachedQuotes(priced, opts.now, opts.storage ?? undefined);
  // Record/clear the per-symbol "nothing newer" stamps for the whole batch (not
  // just the priced ones): a backup call that came back empty or no-fresher must
  // still be remembered so we stop re-pulling it every refresh — but only for
  // data that does *not* need an update right now (the user's rule): a NAV fund
  // (publishes at most once a day) or a market symbol while the exchange is
  // closed. An open-market stock may yet get a fresh tick next refresh, so it is
  // never suppressed.
  for (const symbol of batch) {
    const priorVd = priorVdFor.get(symbol) ?? null;
    const finalVd = opts.quotes.get(symbol)?.valueDate ?? null;
    const advanced = finalVd !== null && (priorVd === null || finalVd > priorVd);
    if (advanced) {
      clearTiingoNoNewer(symbol, opts.storage ?? undefined);
      continue;
    }
    const updateNotNeeded = opts.navSymbols.has(symbol) || !opts.marketOpen;
    if (updateNotNeeded) {
      // The backup had nothing fresher than what we already held for this target.
      recordTiingoNoNewer(symbol, opts.expected, opts.now, opts.storage ?? undefined);
    }
  }
  return gained;
}

/**
 * Run the Tiingo fallback for one refresh cycle. Never throws for a transient
 * failure: the primary's result always stands and any Tiingo gap is reported on
 * `error`. When `proxyUrl` is null (fallback not configured) this is a no-op that
 * just returns the input quotes and the current (zero-ish) budget snapshot.
 */
export async function runTiingoFallback(options: TiingoFallbackOptions): Promise<TiingoFallbackResult> {
  const {
    symbols,
    navSymbols,
    quotes,
    report,
    proxyUrl,
    now = Date.now(),
    storage,
    fetchImpl,
    manual = false,
    forceAll = false,
    reserveCredits = 0,
    sizeForSymbol,
  } = options;

  if (!proxyUrl) {
    return { quotes, tiingoSymbols: [], budget: budgetView(now, storage), error: null };
  }

  const expected = latestSettledSessionDate(new Date(now));
  const marketOpen = isUsMarketOpen(new Date(now));
  // Treat both budget-deferred and attempted-but-failed primary symbols as
  // "primary fell short" so the backup still chases a fund the primary couldn't
  // price (the FSKAX case), now that `failed` is split out from `deferred`.
  const primaryFellShort = new Set([...report.deferred, ...report.failed]);
  const tiingoSymbols: string[] = [];
  let error: PriceError | null = null;

  // Per-symbol "backup had nothing newer" suppression. Once Tiingo confirms it
  // holds nothing fresher than what we already have for `expected`, stop
  // re-pulling that symbol on every refresh until the cooldown lapses or a newer
  // target appears. The explicit "route everything through the backup" button
  // (`forceAll`) bypasses this entirely.
  const noNewer = forceAll ? {} : readTiingoNoNewer(storage ?? undefined);
  const suppressedByNoNewer = (symbol: string): boolean => {
    const stamp = noNewer[symbol];
    if (!stamp) return false;
    // A newer target than the one we recorded against lifts the suppression.
    if (stamp.expected !== expected) return false;
    return now - stamp.at < TIINGO_NO_NEWER_COOLDOWN_MS;
  };

  // Every budget check in this run honours the reserve, so the gate may use up to
  // `remaining − reserveCredits` credits (clamped at 0) and no further.
  const budgetNow = (): Budget => readBudget(now, storage, reserveCredits);

  const merge = (batch: string[]): Promise<string[]> =>
    fetchAndMerge(batch, { proxyUrl, navSymbols, quotes, expected, marketOpen, now, storage, fetchImpl });

  // --- NAV funds: peer-confirmation + canary --------------------------------
  const navMissing: string[] = [];
  let peerPublished = false;
  let peerPublishedAt: number | null = null;
  for (const symbol of symbols) {
    if (!navSymbols.has(symbol)) continue;
    const q = quotes.get(symbol);
    const held = q?.valueDate ?? null;
    if (held === null || q?.price == null || held < expected) {
      if (!suppressedByNoNewer(symbol)) navMissing.push(symbol);
    } else if (held >= expected) {
      // A fresh target-date NAV from the *primary* for some other fund is free
      // evidence the cycle is flowing (Tier 1).
      peerPublished = true;
      const at = q?.at ?? null;
      if (at !== null && (peerPublishedAt === null || at < peerPublishedAt)) peerPublishedAt = at;
    }
  }

  try {
    if (navMissing.length > 0) {
      if (forceAll) {
        // "Route everything through the backup provider": fetch every still-behind
        // NAV fund right now (budget-gated), bypassing the canary/peer timing
        // gates. The navMissing set is already "not recent" (behind the latest
        // settled session), so the "unless recent" rule is preserved.
        const room = selectWithinBudget(navMissing, budgetNow());
        tiingoSymbols.push(...(await merge(room)));
      } else {
        const state = readTiingoState(storage ?? undefined);
        const today = etDay(now);
        const canaryCountToday = state.canaryDay === today ? state.canaryCount : 0;
        // Canary pick: the largest still-missing holding (cold-start proxy for
        // "most likely to have published"); ties broken by symbol order.
        const canaryPick =
          [...navMissing].sort((a, b) => (sizeForSymbol?.(b) ?? 0) - (sizeForSymbol?.(a) ?? 0))[0] ?? null;

        const decision = decideNav({
          missingFunds: navMissing,
          peerPublished,
          peerPublishedAt,
          canaryPick,
          earliestHabitMin: null,
          lastCanaryAt: state.lastCanaryAt,
          canaryCountToday,
          now,
          budget: budgetNow(),
        });

        // A manual tap may probe immediately even if the timing gates would WAIT,
        // provided there is no peer evidence, a candidate exists, the daily cap is
        // not yet hit, and budget remains.
        const manualCanary =
          manual &&
          !peerPublished &&
          decision.action === "wait" &&
          canaryPick !== null &&
          canaryCountToday < NAV_MAX_PROBES_PER_DAY &&
          budgetNow().hasRoom();

        if (decision.action === "fetch_laggards") {
          tiingoSymbols.push(...(await merge(decision.symbols)));
        } else if (decision.action === "canary" || manualCanary) {
          const pick = decision.action === "canary" ? decision.symbols[0] : (canaryPick as string);
          // Persist the probe stamp + counter (ET-day-scoped) before fetching.
          const nextState: TiingoState = {
            canaryDay: today,
            canaryCount: canaryCountToday + 1,
            lastCanaryAt: now,
            lastQuickRefreshAt: state.lastQuickRefreshAt,
          };
          writeTiingoState(nextState, storage ?? undefined);
          const got = await merge([pick]);
          tiingoSymbols.push(...got);
          // Canary fresh ⇒ the cycle has published and the primary missed it:
          // promote every still-missing fund to a laggard fetch (budget-gated).
          const probed = quotes.get(pick);
          const fresh = !!got.length && (probed?.valueDate ?? "") >= expected;
          if (fresh) {
            const laggards = navMissing.filter((s) => s !== pick);
            const room = selectWithinBudget(laggards, budgetNow());
            tiingoSymbols.push(...(await merge(room)));
          }
        }
      }
    }

    // --- Market (stock/ETF) symbols the primary fell short on ----------------
    const marketCandidates: string[] = [];
    for (const symbol of symbols) {
      if (navSymbols.has(symbol)) continue;
      const q = quotes.get(symbol);
      const held = q?.valueDate ?? null;
      const primaryFailed = primaryFellShort.has(symbol) || !q || q.price === null;
      if (suppressedByNoNewer(symbol)) continue;
      if (marketSymbolEligible({ heldDate: held, expectedDate: expected, primaryFailed })) {
        marketCandidates.push(symbol);
      }
    }
    if (marketCandidates.length > 0) {
      const room = selectWithinBudget(marketCandidates, budgetNow());
      tiingoSymbols.push(...(await merge(room)));
    }
  } catch (err) {
    error = err instanceof PriceError ? err : new PriceError((err as Error).message, { retryable: true });
  }

  return { quotes, tiingoSymbols, budget: budgetView(now, storage), error };
}

/**
 * Whether the app should run a Tiingo **startup quick-refresh**: on load, use
 * Tiingo (no per-minute cap → fast) when prices are *badly* outdated. Triggered
 * by either *not holding the latest settled close* (market closed) or >1h stale
 * during market hours. The ~1h floor (via {@link TiingoState.lastQuickRefreshAt})
 * keeps this to about once an hour, preserving the budget for true fallbacks. A
 * manual tap bypasses the throttle entirely.
 *
 * The market-closed rule is deliberately eager: the latest settled close is the
 * freshest data that exists while the exchange is shut, so as soon as we *don't*
 * hold it we fetch — even the morning after, when a stale-but-<24h cache used to
 * suppress the pull. The only brake is "did we already pull in the last hour?":
 * a recent update means there is nothing new worth spending Tiingo credits on.
 */
export function shouldQuickRefresh(args: {
  now: number;
  marketOpen: boolean;
  lastQuickRefreshAt: number | null;
  /** The freshest known price observation time across the book, or null. */
  freshestPriceAt: number | null;
  /**
   * Whether the book already holds the latest settled session close for every
   * fetchable holding (market symbols vs the settled session, NAV funds vs their
   * latest expected publish). Only consulted while the market is closed.
   */
  holdsLatestClose: boolean;
  /** True to skip the once-per-hour throttle (a manual tap). */
  manual?: boolean;
}): boolean {
  const { now, marketOpen, lastQuickRefreshAt, freshestPriceAt, holdsLatestClose, manual = false } = args;
  if (!manual && lastQuickRefreshAt !== null && now - lastQuickRefreshAt < HOUR_MS) return false;
  if (marketOpen) {
    // During market hours: badly outdated = >1h since the freshest observation.
    return freshestPriceAt === null || now - freshestPriceAt > HOUR_MS;
  }
  // Market closed: the latest settled close is the freshest data that exists, so
  // fire whenever we don't already hold it — unless we pulled within the last
  // hour, where a fresh update means there is nothing new worth a Tiingo call.
  if (!manual && freshestPriceAt !== null && now - freshestPriceAt < HOUR_MS) return false;
  return !holdsLatestClose;
}

/** Record that a startup quick-refresh just ran, for the once-per-hour throttle. */
export function noteQuickRefresh(now: number, storage?: StorageLike | null): void {
  const state = readTiingoState(storage ?? undefined);
  writeTiingoState({ ...state, lastQuickRefreshAt: now }, storage ?? undefined);
}

/**
 * Reserve this many Tiingo credits — the startup quick-refresh never spends the
 * last few (nor the full cap), so a true gap-fill fallback later in the session
 * still has headroom.
 */
export const STARTUP_TIINGO_RESERVE = 5;
/**
 * Below this many outdated holdings the Twelve Data primary (8 credits/min)
 * repopulates the whole book within about a minute, so the startup quick-refresh
 * leaves the scarcer Tiingo budget untouched.
 */
export const STARTUP_TIINGO_MIN_OUTDATED = 8;

export type StartupRefreshRoute = "twelve" | "tiingo" | "split";

export interface StartupRefreshPlan {
  /** Which provider(s) the startup quick-refresh should use this round. */
  route: StartupRefreshRoute;
  /** Credits Tiingo may spend this round (0 for the all-Twelve route). */
  tiingoBudget: number;
}

/**
 * Decide how the startup quick-refresh routes a badly-outdated book between the
 * Twelve Data primary and the Tiingo backup, honouring two hard rules:
 *
 *  - **Never spend the last {@link STARTUP_TIINGO_RESERVE} Tiingo credits** (nor
 *    the full cap): the usable Tiingo budget is `remaining − reserve`.
 *  - **Leave Tiingo alone for small outdated sets** (≤
 *    {@link STARTUP_TIINGO_MIN_OUTDATED}): the Twelve Data free tier (8 credits/
 *    min) clears that many holdings within a minute, so spending Tiingo buys
 *    nothing.
 *
 * Given those it routes everything via **Tiingo** when the usable budget covers
 * the whole outdated set, a **split** (Tiingo for as many as the usable budget
 * allows, Twelve Data for the rest) when the set is larger but some budget
 * remains, and everything via **Twelve Data** when no usable budget is left (a
 * split is impossible) or Tiingo isn't configured.
 */
export function planStartupRefresh(args: {
  outdatedCount: number;
  tiingoRemaining: number;
  tiingoAvailable: boolean;
  reserve?: number;
  minOutdated?: number;
}): StartupRefreshPlan {
  const reserve = args.reserve ?? STARTUP_TIINGO_RESERVE;
  const minOutdated = args.minOutdated ?? STARTUP_TIINGO_MIN_OUTDATED;
  const allTwelve: StartupRefreshPlan = { route: "twelve", tiingoBudget: 0 };
  if (!args.tiingoAvailable) return allTwelve;
  // Small outdated sets never warrant a Tiingo spend.
  if (args.outdatedCount <= minOutdated) return allTwelve;
  const usable = Math.max(0, args.tiingoRemaining - reserve);
  // No usable Tiingo budget ⇒ a split is impossible ⇒ wire everything to Twelve.
  if (usable <= 0) return allTwelve;
  // The whole outdated set fits within the usable budget ⇒ one capped Tiingo pull.
  if (usable >= args.outdatedCount) return { route: "tiingo", tiingoBudget: args.outdatedCount };
  // Otherwise split: Tiingo takes what the budget allows, Twelve Data the rest.
  return { route: "split", tiingoBudget: usable };
}

export const TIINGO_GATE_TIMING = {
  firstProbeMinutes,
  navCooldownFor,
  etMinutesOfDay,
};
