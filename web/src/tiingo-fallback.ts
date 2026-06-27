/**
 * Web Tiingo-fallback orchestration — the wiring layer that runs *after* the
 * Twelve Data (primary) pass in a refresh and decides, per the shared gate in
 * `tiingo-gate.ts`, whether to spend any Tiingo calls to fill what the primary
 * missed. It owns the I/O the pure gate deliberately avoids: reading/writing the
 * ET-reset Tiingo budget + quick-refresh state, fetching via the `/price` Worker
 * proxy, and merging results back into the quote map.
 *
 * It engages for two situations (see `docs/tiingo_fallback_plan.md` §Web design):
 *   (a) symbols Twelve Data left **missing/stale** (including the FSKAX-style
 *       upstream gap where the primary serves a too-old bar), and
 *   (b) the **over-quota / 429** case where the free-tier budget is spent.
 * NAV funds are treated **exactly like stocks** here: the instant one needs a
 * price the primary couldn't supply, it joins the same eligibility + budget pass,
 * and bounded re-probing comes from the shared "nothing newer" cooldown.
 */

import {
  readTiingoCreditLog,
  readTiingoState,
  readTiingoNoNewer,
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
import { type QuoteLoadReport, FREE_TIER } from "./quotes";
import { fetchTiingoQuotes } from "./tiingo";
import {
  Budget,
  etMinutesOfDay,
  firstProbeMinutes,
  marketSymbolEligible,
  navCooldownFor,
  selectWithinBudget,
  WEB_DAILY_CAP,
  WEB_HOURLY_CAP,
} from "./tiingo-gate";
import { tiingoFrozen } from "./provider-breaker";
import { efficiencySpillEligible } from "./provider-fanout";
import { ledgerReservation, type Reservation } from "./reservation";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Milliseconds from `now` until the start of the next clock hour (:00). Used to
 * advise the caller how long to wait before retrying when the Tiingo budget
 * resets and a blocked fallback becomes available again.
 */
export function msUntilNextHour(now: number): number {
  const ms = HOUR_MS - (now % HOUR_MS);
  return ms > 0 ? ms : HOUR_MS;
}

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
  /**
   * The subset of {@link tiingoSymbols} that ended up on the backup because of a
   * *genuine fallback* — the primary actually tried to price them this round and
   * fell short (the value was unavailable or outdated), so they were "pulled from
   * one provider, then pulled from the other" (i.e. they were in {@link
   * QuoteLoadReport.failed}). Symbols the primary merely *deferred* for budget
   * (a smart-routing efficiency choice — never attempted on the primary) are
   * **excluded**, so the UI only flags a fallback the user would consider one.
   */
  fallbackSymbols: string[];
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
   * A manual "Refresh via Tiingo now" tap. Used by the startup quick-refresh
   * throttle (`quickRefreshDue`) to let a user tap bypass the once-per-hour gate;
   * the unified fallback itself treats every symbol the same regardless.
   */
  manual?: boolean;
  /**
   * A manual "route everything through the backup provider" pull (Settings →
   * "Try the backup data provider now"): fetch *every* still-behind holding from
   * Tiingo directly. The "unless the data is recent" rule and the hard budget caps
   * still apply — symbols whose held value already covers the latest settled
   * session are left untouched.
   */
  forceAll?: boolean;
  /**
   * A user-driven cache-distrust re-pull — the **standard manual Refresh tap**,
   * which in a closed/settled market escalates to a full force-fetch of every
   * price (`buildQuoteOptions` `forceAll`). Unlike {@link forceAll} (the separate
   * "route everything through Tiingo" button) the Twelve Data primary still leads;
   * this flag only changes the backup's behaviour for the overflow Twelve Data
   * deferred. It (a) lets the market-hours **efficiency spill** fire even while the
   * exchange is shut — so a big manual round's deferred overflow is filled via
   * Tiingo in parallel rather than trickling through the per-minute cap over
   * minutes — and (b) bypasses the per-symbol "nothing newer" cooldown, so a user
   * who taps Refresh again genuinely re-verifies the book rather than being told
   * "already checked". Size/deferred gates still apply, so a small manual round is
   * unaffected (its overflow drains through the normal per-minute burst).
   */
  manualForce?: boolean;
  /**
   * Hold back this many Tiingo credits from every budget check in this run (the
   * startup quick-refresh sets it so a true gap-fill fallback later in the
   * session keeps some headroom). Defaults to 0 — normal fallbacks may spend the
   * full self-capped budget.
   */
  reserveCredits?: number;
  /** Last-known EUR size per symbol. Retained for callers; not used for routing. */
  sizeForSymbol?: (symbol: string) => number;
  /**
   * The single reservation authority (`reservation.ts`, audit Rec 4) every Tiingo
   * spend in this run books through. Defaults to the production
   * {@link ledgerReservation} over this call's `storage`. The eligibility/`reserve`
   * gate above still selects which symbols are worth a call, but the actual debit
   * now goes through the authority's atomic read-and-debit rather than a separate
   * `recordTiingoCredits`, so the fallback can no longer get around the shared
   * Tiingo budget (and its 429-breaker freeze) the graph/FX legs already respect.
   */
  reservation?: Reservation;
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
  // Central safety-net integration: the 429 circuit breaker (provider-breaker.ts)
  // freezes Tiingo until the next clock hour. Rather than a separate early-return
  // guard, fold the frozen state directly into the budget — when frozen, report
  // 0 remaining so selectWithinBudget naturally returns no symbols and the
  // central safety net (planTwelveDataSafetyNet) catches the holes.
  if (tiingoFrozen(now, storage ?? null)) {
    return new Budget(WEB_HOURLY_CAP, WEB_DAILY_CAP, WEB_HOURLY_CAP, WEB_DAILY_CAP);
  }
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

/**
 * The Tiingo hourly/daily usage as it stands **right now**, read live from the
 * persisted credit log. Unlike the snapshot returned inside a
 * {@link TiingoFallbackResult} (taken when the quote fallback last ran), this
 * reflects *every* Tiingo spend since — including the 1D/1W graph-bar and
 * FX-history pulls — so the Overview's "used fallback" line counts those too.
 */
export function tiingoBudgetView(now: number, storage?: StorageLike | null): TiingoBudgetView {
  return budgetView(now, storage);
}

function budgetView(now: number, storage: StorageLike | null | undefined): TiingoBudgetView {
  const b = readBudget(now, storage);
  // Floor the used counts at 0 so a refunded charge straddling the clock-hour /
  // ET-day boundary never surfaces a nonsensical negative "X/40 this hour".
  return {
    hourUsed: Math.max(0, b.hourUsed),
    hourLimit: b.hourlyCap,
    dayUsed: Math.max(0, b.dayUsed),
    dayLimit: b.dailyCap,
  };
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
    reservation: Reservation;
  },
): Promise<string[]> {
  if (batch.length === 0) return [];
  // Snapshot the value-date we held *before* the merge, per symbol, so we can
  // tell afterwards whether the backup actually advanced it.
  const priorVdFor = new Map<string, string | null>();
  for (const symbol of batch) priorVdFor.set(symbol, opts.quotes.get(symbol)?.valueDate ?? null);
  // Reserve the budget up-front through the single reservation authority (same
  // discipline as the Twelve Data path): the grant atomically reads-and-debits
  // the shared Tiingo ledger, so a failed call still counts against the self-cap
  // rather than allowing a retry storm, and two overlapping runs can't both
  // read a full budget and overshoot. The batch was already clamped to the
  // budget (minus any soft reserve) by `selectWithinBudget`, so the grant covers
  // the whole batch in the normal single-flight case.
  opts.reservation.reserve("tiingo", batch.length, opts.now);
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
 *
 * Budget enforcement is structural: the 429 breaker and hourly/daily caps are
 * folded into {@link readBudget}, so {@link selectWithinBudget} naturally returns
 * 0 symbols when Tiingo is frozen or exhausted. Unfilled holes are left for the
 * central safety net ({@link planTwelveDataSafetyNet}) to catch on Twelve Data,
 * and the budget-blocked state is surfaced on `error` so the polling log reports
 * it — fallback pulls never fall under the radar.
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
    forceAll = false,
    manualForce = false,
    reserveCredits = 0,
    reservation = ledgerReservation(storage ?? null),
  } = options;

  if (!proxyUrl) {
    return { quotes, tiingoSymbols: [], fallbackSymbols: [], budget: budgetView(now, storage), error: null };
  }

  const expected = latestSettledSessionDate(new Date(now));
  const marketOpen = isUsMarketOpen(new Date(now));
  // Treat both budget-deferred and attempted-but-failed primary symbols as
  // "primary fell short" so the backup still chases a fund the primary couldn't
  // price (the FSKAX case), now that `failed` is split out from `deferred`.
  const primaryFellShort = new Set([...report.deferred, ...report.failed]);
  // The symbols the primary *attempted* this round but couldn't price (value
  // unavailable or outdated). A backup fill for one of these is a genuine
  // fallback — "pulled from one provider, then the other" — as opposed to a
  // symbol the primary merely deferred for budget (a smart-routing efficiency
  // reroute that was never attempted on the primary).
  const primaryAttemptedButFailed = new Set(report.failed);
  const tiingoSymbols: string[] = [];
  let error: PriceError | null = null;

  // Per-symbol "backup had nothing newer" suppression. Once Tiingo confirms it
  // holds nothing fresher than what we already have for `expected`, stop
  // re-pulling that symbol on every refresh until the cooldown lapses or a newer
  // target appears. The explicit "route everything through the backup" button
  // (`forceAll`) and a user-driven cache-distrust Refresh (`manualForce`) bypass
  // this entirely — both mean the user explicitly asked to re-verify the book.
  const noNewer = forceAll || manualForce ? {} : readTiingoNoNewer(storage ?? undefined);
  const suppressedByNoNewer = (symbol: string): boolean => {
    const stamp = noNewer[symbol];
    if (!stamp) return false;
    // A newer target than the one we recorded against lifts the suppression.
    if (stamp.expected !== expected) return false;
    return now - stamp.at < TIINGO_NO_NEWER_COOLDOWN_MS;
  };

  // Every budget check in this run honours the reserve, so the gate may use up to
  // `remaining − reserveCredits` credits (clamped at 0) and no further.
  // When Tiingo is frozen (429 breaker) or its budget is exhausted, readBudget
  // reports 0 remaining and selectWithinBudget returns no symbols — the central
  // safety net then catches the holes.
  const budgetNow = (): Budget => readBudget(now, storage, reserveCredits);

  const merge = (batch: string[]): Promise<string[]> =>
    fetchAndMerge(batch, { proxyUrl, navSymbols, quotes, expected, marketOpen, now, storage, fetchImpl, reservation });

  // --- Unified fallback: NAVs are treated exactly like stocks ---------------
  // The moment a symbol needs a price the primary couldn't supply — it failed on
  // the primary, or what we hold is older than the latest settled session — it is
  // eligible for one budget-clamped Tiingo fill, whether it is a stock/ETF or a
  // NAV fund. The old NAV-only peer-confirmation/canary timing path is gone:
  // bounded re-probing now comes from the very same `suppressedByNoNewer` cooldown
  // that already governs a closed-market stock (a fund Tiingo has nothing fresher
  // for is stamped and left alone until the cooldown lapses or a newer settled
  // session appears), so a NAV and a stock are filled by one identical path.
  try {
    const candidates: string[] = [];
    // Size-based efficiency spill — the whole policy is owned by Pillar 5's
    // provider-spilling authority (`efficiencySpillEligible` in
    // `provider-fanout.ts`), so it can be tuned in one place alongside the
    // login/manual `planFanout` spill. In short: when the round *originally* asked
    // for a big sleeve (`symbols` is the whole requested set, e.g. all 17), its
    // Twelve Data deferred overflow is spilled to Tiingo in parallel rather than
    // left to trickle through the per-minute cap — regardless of market hours or
    // whether the round was manual or automatic.
    const requestedCount = symbols.length;
    const deferredSet = new Set(report.deferred);
    for (const symbol of symbols) {
      if (suppressedByNoNewer(symbol)) continue;
      const q = quotes.get(symbol);
      const held = q?.valueDate ?? null;
      const primaryFailed = primaryFellShort.has(symbol) || !q || q.price === null;
      const eligible = marketSymbolEligible({ heldDate: held, expectedDate: expected, primaryFailed });
      const efficiencyEligible = efficiencySpillEligible({
        symbol,
        requestedCount,
        deferred: deferredSet,
      });
      if (eligible || efficiencyEligible) {
        candidates.push(symbol);
      }
    }
    if (candidates.length > 0) {
      const room = selectWithinBudget(candidates, budgetNow());
      if (room.length > 0) {
        tiingoSymbols.push(...(await merge(room)));
      } else {
        // Budget blocked: candidates existed but the budget (or 429 breaker)
        // prevented any spend. Surface this clearly so fallback pulls never fall
        // under the radar — the caller logs it and the central safety net
        // (planTwelveDataSafetyNet) catches the unfilled holes on Twelve Data.
        // Tagged HTTP 429 because this *is* the over-quota case (the hourly/daily
        // credit cap is spent), so `describeTiingoError` reports "credits look
        // used up" rather than the misleading "unreachable; check the Worker".
        error = new PriceError(
          `Tiingo budget exhausted — ${candidates.length} symbol(s) needed but blocked by limits. ` +
            "Central safety net will catch remaining holes on Twelve Data.",
          { status: 429, retryable: true, retryAfterMs: msUntilNextHour(now) },
        );
      }
    }
  } catch (err) {
    error = err instanceof PriceError ? err : new PriceError((err as Error).message, { retryable: true });
  }

  // Genuine fallback = a backup fill for a symbol the primary actually attempted
  // and failed to price this round (unavailable / outdated). Budget-deferred
  // symbols the primary never tried are an efficiency reroute, not a fallback.
  const fallbackSymbols = tiingoSymbols.filter((s) => primaryAttemptedButFailed.has(s));

  return { quotes, tiingoSymbols, fallbackSymbols, budget: budgetView(now, storage), error };
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
 *  - **Leave Tiingo alone for small outdated sets** (≤ the Twelve Data
 *    per-minute limit): the Twelve Data primary clears that many holdings within
 *    a single minute, so spending the scarcer Tiingo budget buys nothing. The
 *    threshold therefore tracks the configured `twelveDataPerMinute` limit
 *    ({@link FREE_TIER}.creditsPerMinute) rather than a hard-coded number.
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
  const minOutdated = args.minOutdated ?? FREE_TIER.creditsPerMinute;
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

/** Which provider the login warm-up routes its quote pull through. */
export type PrefetchRoute = "twelve" | "tiingo";

export interface PrefetchPlan {
  /**
   * The stock/ETF/fund symbols to warm via a plain **quote** pull this round on
   * {@link route} (FX is warmed separately). Market sleeve only — NAV funds are
   * split out into {@link navSymbols}, and any symbol a graph-bar pull already
   * covers is removed (its bar doubles as the quote, so it is never re-bought).
   */
  symbols: string[];
  /** Which provider to route the quote pull through. */
  route: PrefetchRoute;
  /**
   * NAV funds to warm — **always via Twelve Data**, never Tiingo. A fund's NAV
   * has no intraday series and the 1D/1W graphs never pull it, so spending an
   * expensive (hourly-capped) Tiingo credit on one would be pure waste; the cheap
   * Twelve Data quote is the right tool. Empty while the market is open (a NAV
   * cannot strike mid-session).
   */
  navSymbols: string[];
  /**
   * Market sleeve symbols whose **1D intraday bars** are worth pulling now (the
   * live session graph is stale). Fetched via Tiingo's `?intraday=` feed — which
   * also yields each symbol's current mark, so these double as the quote refresh.
   */
  graphSessionSymbols: string[];
  /**
   * Market sleeve symbols whose **1W daily bars** are worth pulling now (the week
   * graph is stale). Fetched via Tiingo's `?daily=` feed.
   */
  graphWeekSymbols: string[];
}

/**
 * Decide what the login warm-up should fetch this round, and via which provider.
 * Kept pure so the market-aware policy is testable without the app shell.
 *
 * The forex market trades ~24/5 and values the *whole* book, so the caller warms
 * FX first in line, unconditionally — it is not represented here. This decides
 * the stock/ETF/fund quote set **and** the live-graph bar pulls, so no credit is
 * spent on prices that cannot have changed since the last session, and the
 * expensive (hourly-capped) Tiingo credits are reserved for symbols that truly
 * need bars:
 *
 *  - **Market open** — warm only the stocks/ETFs (`marketSymbols`): intraday
 *    prices move continuously, while a fund's once-a-day NAV cannot change mid
 *    session, so spending credits on NAVs now buys nothing.
 *  - **Market closed** — nothing is worth a credit *unless* something is behind:
 *    a fund still awaiting today's NAV (the after-close, pre-NAV window) or a
 *    market symbol still missing its latest settled close (an outdated catch-up).
 *    With everything in hand the warm-up makes no quote call at all.
 *
 * **NAV funds always route to Twelve Data** (`navSymbols`), never Tiingo — they
 * have no intraday series and the graphs never pull them, so the scarce Tiingo
 * budget goes only where bars are needed.
 *
 * **Graph staleness folds in (idea #1 — bars double as quotes).** When the 1D/1W
 * graph is stale and Tiingo is available, the market sleeve symbols missing bars
 * (`graphSessionStale`/`graphWeekStale`) are pulled as Tiingo intraday/daily
 * bars. Each bar's newest point *is* the current mark, so those symbols are
 * removed from the quote set — one Tiingo spend covers both the graph and the
 * holding row, never double-buying.
 *
 * A large residual closed-market quote catch-up (more than `minBatch`, default the
 * Twelve Data per-minute limit, {@link FREE_TIER}.creditsPerMinute) is rapid-fired
 * through Tiingo — one batched request with no per-minute cap — instead of
 * trickling that-many-per-minute through the Twelve Data primary; every other case
 * stays on the primary.
 */
export function planPrefetch(args: {
  marketOpen: boolean;
  /** Stock/ETF tickers from the plan, priority-ordered (largest first). */
  marketSymbols: string[];
  /** Market symbols still missing their latest settled close. */
  outdatedMarketSymbols: string[];
  /** NAV funds still awaiting their latest expected publish. */
  awaitingNavSymbols: string[];
  /** Whether the Tiingo backup (a configured /price proxy) is available. */
  tiingoAvailable: boolean;
  /** Market sleeve symbols missing 1D intraday bars (graphs enabled & stale). */
  graphSessionStale?: string[];
  /** Market sleeve symbols missing 1W daily bars (graphs enabled & stale). */
  graphWeekStale?: string[];
  minBatch?: number;
}): PrefetchPlan {
  const minBatch = args.minBatch ?? FREE_TIER.creditsPerMinute;
  // Graph bars only when there is a Tiingo pipe to pull them cheaply through.
  const graphSessionSymbols = args.tiingoAvailable ? [...(args.graphSessionStale ?? [])] : [];
  const graphWeekSymbols = args.tiingoAvailable ? [...(args.graphWeekStale ?? [])] : [];
  // Symbols whose current mark a graph-bar pull will already deliver — drop them
  // from the quote set so one Tiingo spend is never double-bought as a quote too.
  const coveredByGraph = new Set([...graphSessionSymbols, ...graphWeekSymbols]);
  if (args.marketOpen) {
    // Open: only the stocks/ETFs move now; warm them on the primary, minus any a
    // graph-bar pull already covers. NAVs cannot strike mid-session ⇒ none.
    const symbols = args.marketSymbols.filter((s) => !coveredByGraph.has(s));
    return { symbols, route: "twelve", navSymbols: [], graphSessionSymbols, graphWeekSymbols };
  }
  // Closed: warm whatever market closes are behind, minus those a graph pull
  // already covers; NAV funds are split out to Twelve Data unconditionally.
  const marketQuote = args.outdatedMarketSymbols.filter((s) => !coveredByGraph.has(s));
  const navSymbols = [...args.awaitingNavSymbols];
  // Tiingo rapid-fire only for a genuinely large residual *market* catch-up.
  const route: PrefetchRoute =
    args.tiingoAvailable && marketQuote.length > minBatch ? "tiingo" : "twelve";
  return { symbols: marketQuote, route, navSymbols, graphSessionSymbols, graphWeekSymbols };
}

export const TIINGO_GATE_TIMING = {
  firstProbeMinutes,
  navCooldownFor,
  etMinutesOfDay,
};
