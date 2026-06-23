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
  recordNavPublish,
  recordTiingoCredits,
  creditsSpentWithin,
  tiingoCreditsSpentToday,
  writeCachedQuotes,
  writeTiingoState,
  type StorageLike,
  type TiingoState,
} from "./cache";
import { latestSettledSessionDate } from "./market-hours";
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
  /** Last-known EUR size per symbol, used only to pick the largest as canary. */
  sizeForSymbol?: (symbol: string) => number;
}

/** Snapshot the current Tiingo budget from the persisted credit log. */
function readBudget(now: number, storage: StorageLike | null | undefined): Budget {
  const log = readTiingoCreditLog(now, undefined, storage ?? undefined);
  const hourUsed = creditsSpentWithin(log, now, HOUR_MS);
  const dayUsed = tiingoCreditsSpentToday(log, now);
  return new Budget(hourUsed, dayUsed, WEB_HOURLY_CAP, WEB_DAILY_CAP);
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
 */
async function fetchAndMerge(
  batch: string[],
  opts: {
    proxyUrl: string;
    navSymbols: ReadonlySet<string>;
    quotes: Map<string, Quote>;
    now: number;
    storage: StorageLike | null | undefined;
    fetchImpl?: FetchLike;
  },
): Promise<string[]> {
  if (batch.length === 0) return [];
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
    sizeForSymbol,
  } = options;

  if (!proxyUrl) {
    return { quotes, tiingoSymbols: [], budget: budgetView(now, storage), error: null };
  }

  const expected = latestSettledSessionDate(new Date(now));
  const deferred = new Set(report.deferred);
  const tiingoSymbols: string[] = [];
  let error: PriceError | null = null;

  const merge = (batch: string[]): Promise<string[]> =>
    fetchAndMerge(batch, { proxyUrl, navSymbols, quotes, now, storage, fetchImpl });

  // --- NAV funds: peer-confirmation + canary --------------------------------
  const navMissing: string[] = [];
  let peerPublished = false;
  let peerPublishedAt: number | null = null;
  for (const symbol of symbols) {
    if (!navSymbols.has(symbol)) continue;
    const q = quotes.get(symbol);
    const held = q?.valueDate ?? null;
    if (held === null || q?.price == null || held < expected) {
      navMissing.push(symbol);
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
        budget: readBudget(now, storage),
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
        readBudget(now, storage).hasRoom();

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
          const room = selectWithinBudget(laggards, readBudget(now, storage));
          tiingoSymbols.push(...(await merge(room)));
        }
      }
    }

    // --- Market (stock/ETF) symbols the primary fell short on ----------------
    const marketCandidates: string[] = [];
    for (const symbol of symbols) {
      if (navSymbols.has(symbol)) continue;
      const q = quotes.get(symbol);
      const held = q?.valueDate ?? null;
      const primaryFailed = deferred.has(symbol) || !q || q.price === null;
      if (marketSymbolEligible({ heldDate: held, expectedDate: expected, primaryFailed })) {
        marketCandidates.push(symbol);
      }
    }
    if (marketCandidates.length > 0) {
      const room = selectWithinBudget(marketCandidates, readBudget(now, storage));
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
 * by either being ≥1 settled session behind (market closed) or >1h stale during
 * market hours. The ~1h floor (via {@link TiingoState.lastQuickRefreshAt}) keeps
 * this to about once an hour, preserving the budget for true fallbacks. A manual
 * tap bypasses the throttle entirely.
 */
export function shouldQuickRefresh(args: {
  now: number;
  marketOpen: boolean;
  lastQuickRefreshAt: number | null;
  /** The freshest known price observation time across the book, or null. */
  freshestPriceAt: number | null;
  /** True to skip the once-per-hour throttle (a manual tap). */
  manual?: boolean;
}): boolean {
  const { now, marketOpen, lastQuickRefreshAt, freshestPriceAt, manual = false } = args;
  if (!manual && lastQuickRefreshAt !== null && now - lastQuickRefreshAt < HOUR_MS) return false;
  if (marketOpen) {
    // During market hours: badly outdated = >1h since the freshest observation.
    return freshestPriceAt === null || now - freshestPriceAt > HOUR_MS;
  }
  // Market closed: only worthwhile if we don't already hold a recent observation
  // (within a day); otherwise the latest settled close is already in hand.
  return freshestPriceAt === null || now - freshestPriceAt > 24 * HOUR_MS;
}

/** Record that a startup quick-refresh just ran, for the once-per-hour throttle. */
export function noteQuickRefresh(now: number, storage?: StorageLike | null): void {
  const state = readTiingoState(storage ?? undefined);
  writeTiingoState({ ...state, lastQuickRefreshAt: now }, storage ?? undefined);
}

export const TIINGO_GATE_TIMING = {
  firstProbeMinutes,
  navCooldownFor,
  etMinutesOfDay,
};
