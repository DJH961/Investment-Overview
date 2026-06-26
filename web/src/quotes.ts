/**
 * Free-tier-aware live-quote orchestration.
 *
 * The Twelve Data free plan is the binding constraint everywhere here: **8 API
 * credits per minute, 800 per day, one credit per symbol**. A naive "fetch
 * every symbol on every refresh" blows the per-minute cap the moment a
 * portfolio holds more than eight market instruments — which is exactly what
 * produces the HTTP 429 "Couldn't load live data" dead-end.
 *
 * {@link loadQuotes} keeps the app inside that budget by, in order:
 *   1. serving still-fresh quotes straight from the cache (zero credits),
 *   2. spending at most the credits left in the current minute/day windows,
 *   3. chunking the spend into ≤ per-minute batches and retrying a 429 with
 *      exponential backoff (honouring any `Retry-After`),
 *   4. deferring any remaining stale symbols to their last cached value (and,
 *      failing that, the export's last-known price downstream),
 * and reports exactly what it did so the UI can be honest about staleness.
 */

import {
  creditsSpentWithin,
  creditsSpentToday,
  readCachedEurUsd,
  readCachedFx,
  readCachedQuotes,
  readCreditLog,
  recordCredits,
  readTiingoCreditLog,
  recordTiingoCredits,
  tiingoCreditsSpentToday,
  writeCachedEurUsd,
  writeCachedFx,
  writeCachedQuotes,
  type CachedQuote,
  type StorageLike,
} from "./cache";
import {
  fetchEurUsd,
  fetchFxRates,
  fetchNavQuotes,
  fetchQuotes,
  PriceError,
  type EurUsdQuote,
  type FetchLike,
  type FxRates,
  type Quote,
} from "./prices";
import type { Decimal } from "./decimal-config";
import { isUsMarketOpen, latestSettledSessionDate } from "./market-hours";
import { fetchTiingoEurUsd } from "./tiingo";
import { Budget, etMinutesOfDay, WEB_DAILY_CAP, WEB_HOURLY_CAP } from "./tiingo-gate";

/** Twelve Data free-tier limits — the design constraint for this whole module. */
export const FREE_TIER = {
  /** Max API credits per rolling minute. */
  creditsPerMinute: 8,
  /** Max API credits per rolling day. */
  creditsPerDay: 800,
  /** Credits a batched `/quote` spends per symbol. */
  creditsPerSymbol: 1,
} as const;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Random jitter added to each backoff wait, to de-synchronise retriers. */
const BACKOFF_JITTER_MS = 250;

/** Default freshness window before a cached quote is considered stale. */
export const DEFAULT_CACHE_TTL_MS = 15 * MINUTE_MS;

/**
 * The Twelve Data credits still affordable right now on the shared free-tier
 * budget — the **live** per-minute and per-day headroom read straight from the
 * shared credit ledger. Exposed so the live-graph provider split (item 8) can
 * fill Twelve Data up to this many symbols *after* the quote pass has reserved
 * its share, then spill the overflow to Tiingo. Mirrors the in-`loadQuotes`
 * `budget()` closure so both consult one source of truth.
 */
export function twelveDataBudgetRemaining(
  now: number = Date.now(),
  opts: { creditsPerMinute?: number; creditsPerDay?: number; storage?: StorageLike } = {},
): { minute: number; day: number } {
  const creditsPerMinute = opts.creditsPerMinute ?? FREE_TIER.creditsPerMinute;
  const creditsPerDay = opts.creditsPerDay ?? FREE_TIER.creditsPerDay;
  const log = readCreditLog(now, DAY_MS, opts.storage);
  return {
    minute: Math.max(0, creditsPerMinute - Math.max(0, creditsSpentWithin(log, now, MINUTE_MS))),
    day: Math.max(0, creditsPerDay - Math.max(0, creditsSpentToday(log, now))),
  };
}

/**
 * Freshness window for NAV-priced holdings (mutual funds / money-market).
 * Their NAV publishes only ~once per business day, so a long window keeps the
 * latest available value on screen while barely touching the free-tier budget.
 * Set to 24h so that, outside the evening publish window, a NAV is never
 * re-fetched until its cached value is more than a day old — there is no new
 * price to chase in between, and polling for one only wastes credits.
 */
export const DEFAULT_NAV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Freshness window for a **market** (stock/ETF) symbol whose exchange is closed
 * and whose latest settled close we already hold. The session reopen is detected
 * directly from the market clock on the next refresh, so this only needs to span
 * the longest plausible closed stretch (a four-day holiday weekend) to guarantee
 * that not a single credit is spent re-fetching an unchanged close until the
 * market opens again.
 */
export const DEFAULT_CLOSED_MARKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tunables for {@link navCacheTtlMs} (all optional; sensible defaults apply). */
export interface NavRefreshOptions {
  /** Wall-clock epoch ms; defaults to {@link Date.now}. Injected in tests. */
  now?: number;
  /**
   * Whether the US regular session is open right now. Defaults to deriving it
   * from `now`; injected in tests. While open a NAV cannot strike (it lands only
   * after the close), so there is nothing to chase regardless of what we hold.
   */
  marketOpen?: boolean;
  /** TTL while behind a fresh NAV (poll cadence — same as a normal symbol). */
  shortTtlMs?: number;
  /** TTL once the latest NAV is in hand, or before it is expected. */
  longTtlMs?: number;
}

/**
 * Adaptive freshness window for a NAV-priced holding. Funds publish their NAV
 * only ~once per business day, so polling on a fixed short interval all day
 * wastes the free-tier budget while a fixed long interval can leave today's
 * fresh NAV unseen for hours.
 *
 * The rule is deliberately simple — no attempt to predict *when* tonight's NAV
 * will land, just "poll after the close until it is here":
 *   - **market open**: rest on the long window. A NAV strikes only after the
 *     session closes, and we already hold the prior settled session's NAV, so
 *     there is nothing new to chase mid-session; and
 *   - **market closed**: if we already hold the latest *settled* session's NAV
 *     ({@link latestSettledSessionDate}) there is nothing newer until the next
 *     session closes, so rest on the long window; otherwise poll like a normal
 *     symbol (the short window) until that NAV lands — however late, even past
 *     midnight, with no upper "catch-up" cap.
 */
export function navCacheTtlMs(
  cached: { valueDate?: string | null } | null | undefined,
  options: NavRefreshOptions = {},
): number {
  const {
    now = Date.now(),
    marketOpen = isUsMarketOpen(new Date(now)),
    shortTtlMs = DEFAULT_CACHE_TTL_MS,
    longTtlMs = DEFAULT_NAV_CACHE_TTL_MS,
  } = options;

  // Session open: the NAV cannot strike until after the close, and we already
  // hold the prior settled session's NAV — nothing to chase.
  if (marketOpen) return longTtlMs;
  // Closed: poll until the just-settled session's NAV is in hand, then rest.
  const have = cached?.valueDate ?? null;
  if (have && have >= latestSettledSessionDate(new Date(now))) return longTtlMs;
  return shortTtlMs;
}

/** Tunables for {@link marketCacheTtlMs}. */
export interface MarketRefreshOptions {
  /** TTL while the session is open, or when chasing a not-yet-held close. */
  shortTtlMs?: number;
  /** TTL while the session is closed and the latest close is already in hand. */
  longTtlMs?: number;
  /** Whether the exchange's regular session is open right now. */
  marketOpen: boolean;
  /** Trading day (`YYYY-MM-DD`) of the most recent already-settled close. */
  latestSettledDate: string;
}

/**
 * Eastern minutes-of-day of the NYSE regular close (16:00). A market print
 * captured at or after {@link CLOSE_MINUTES_ET} − {@link CLOSE_ACCEPT_WINDOW_MIN}
 * is treated as the official close (see {@link holdsSettledClose}).
 */
const CLOSE_MINUTES_ET = 16 * 60; // 16:00 ET
/**
 * How many minutes before the official 16:00 ET close a same-session print is
 * still accepted *as* that close. Two minutes is deliberately tight: it accepts
 * a 15:58–15:59 ET capture (≈21:58–21:59 local CET — the user's "accept 21:59"
 * case, effectively the closing value) while still excluding an earlier intraday
 * print such as 15:18 ET (≈21:18 CET), which is re-fetched once after the close
 * to settle it. Widening this would risk accepting genuinely pre-close prints as
 * the close.
 */
const CLOSE_ACCEPT_WINDOW_MIN = 2;

/**
 * Whether a cached **market** quote genuinely holds the latest *settled close*
 * (`latestSettledDate`) — not merely a same-day intraday print.
 *
 * A quote's value-date turns to today's date the moment the session opens, so a
 * mid-session capture (say 15:18 ET) already carries today's value-date even
 * though it is *not* the official 16:00 close. If we treated "value-date ==
 * settled date" as "holds the close", such an intraday capture would wrongly
 * suppress the one post-close fetch that records the real closing price — the
 * symbol would freeze on its last intraday value all evening (the "stopped
 * updating at 22:00 even though the last pull was 21:18" bug).
 *
 * So a quote counts as holding the close when its value-date is at least the
 * settled date **and** either:
 *   - it was not captured while the session was open (`is_market_open` is
 *     `false`/`null`, a settled figure), or
 *   - it was captured within the final {@link CLOSE_ACCEPT_WINDOW_MIN} minutes
 *     before the close (the "accept 21:59" rule): there is essentially no
 *     session left, so the near-close print *is* the close.
 *
 * The provider's `is_market_open` flag is ground truth for the first clause;
 * `priceTime` (the print's observation instant) drives the near-close clause.
 */
export function holdsSettledClose(
  cached:
    | { valueDate?: string | null; marketOpen?: boolean | null; priceTime?: number | null }
    | null
    | undefined,
  latestSettledDate: string,
): boolean {
  const have = cached?.valueDate ?? null;
  if (!have || have < latestSettledDate) return false;
  // A closed-market fetch (or an endpoint that omits the flag) is a settled figure.
  if (cached?.marketOpen !== true) return true;
  // Captured mid-session: accept it as the close only if it lands in the final
  // minutes before 16:00 ET (the "accept 21:59" rule); otherwise re-fetch once
  // after the close to settle it.
  const t = cached?.priceTime ?? null;
  if (t === null) return false;
  return etMinutesOfDay(t) >= CLOSE_MINUTES_ET - CLOSE_ACCEPT_WINDOW_MIN;
}

/**
 * Adaptive freshness window for a **market** (stock/ETF) symbol, the mirror of
 * {@link navCacheTtlMs} for continuously-traded instruments.
 *
 * While the session is open we poll on the short window (prices move intraday).
 * Once it closes there is nothing new until it reopens, so if we already hold
 * the latest settled close (see {@link holdsSettledClose}) we rest on the long
 * window and spend no credits — freeing that budget for late-arriving fund NAVs.
 * If the market is closed but we are *missing* that close — including the case
 * where all we hold is a mid-session intraday print — we fetch once on the short
 * window to capture the official close, then go quiet.
 */
export function marketCacheTtlMs(
  cached:
    | { valueDate?: string | null; marketOpen?: boolean | null; priceTime?: number | null }
    | null
    | undefined,
  options: MarketRefreshOptions,
): number {
  const {
    shortTtlMs = DEFAULT_CACHE_TTL_MS,
    longTtlMs = DEFAULT_CLOSED_MARKET_TTL_MS,
    marketOpen,
    latestSettledDate,
  } = options;
  // Session open: poll live.
  if (marketOpen) return shortTtlMs;
  // Closed and already holding the latest *settled* close: nothing to fetch.
  if (holdsSettledClose(cached, latestSettledDate)) return longTtlMs;
  // Closed but missing that close (or only holding an intraday print): fetch
  // once to capture the official close.
  return shortTtlMs;
}

/** Tunables + injectable seams (tests supply deterministic clock/sleep/storage). */
export interface LoadQuotesOptions {
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a cached quote stays fresh; older entries are re-fetched. */
  cacheTtlMs?: number;
  /**
   * Per-symbol override of {@link cacheTtlMs}. Lets NAV-priced symbols use a
   * longer (daily-ish) window than market symbols in a single call, and adapt
   * it from the cached quote (e.g. poll harder while a fresh NAV is expected).
   * Falls back to `cacheTtlMs` when omitted or when it returns a non-positive
   * value.
   */
  cacheTtlMsForSymbol?: (symbol: string, cached?: CachedQuote) => number;
  /**
   * Force a fresh fetch of **market** (non-NAV) symbols regardless of how fresh
   * their cached quote is — the "pull new prices now" path behind a manual
   * Refresh tap. NAV symbols are deliberately exempt: their once-a-day NAV is
   * governed by {@link cacheTtlMsForSymbol} alone, so a manual tap never burns
   * credits chasing a NAV that cannot have changed. Budget limits still apply,
   * so a forced refresh defers rather than exceeding the free-tier cap.
   */
  forceMarketFetch?: boolean;
  /**
   * Per-symbol escape hatch for a manual "pull now": when it returns true the
   * symbol is re-fetched regardless of how fresh its cached quote is (still
   * within the free-tier budget). Used so a manual Refresh can re-pull a NAV
   * fund that is *behind* its latest expected value — the case the blanket
   * {@link forceMarketFetch} deliberately skips to avoid chasing an unchanged
   * NAV. Evaluated for every symbol; defaults to never forcing.
   */
  forceFetch?: (symbol: string, cached?: CachedQuote) => boolean;
  /**
   * Symbols that are NAV-priced funds (mutual / money-market). These are fetched
   * from Twelve Data's daily `time_series` endpoint (authoritative trading-day
   * NAV) rather than `quote`, which fabricates a "today" date on closed days.
   */
  navSymbols?: ReadonlySet<string>;
  creditsPerMinute?: number;
  creditsPerDay?: number;
  /** Backoff retries for a transient (429/5xx/network) failure. */
  maxRetries?: number;
  /** Base backoff delay; doubles each attempt (with jitter), capped. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

/** What {@link loadQuotes} actually did, for an honest staleness banner. */
export interface QuoteLoadReport {
  /** Symbols whose price came from a fresh live fetch this call. */
  fetched: string[];
  /** Symbols served from a still-fresh cache entry (no credits spent). */
  servedFresh: string[];
  /** Stale/uncached symbols left unfetched to stay within the free-tier budget. */
  deferred: string[];
  /**
   * Symbols we actually *attempted* to fetch this call but got no usable price
   * back for — either the provider returned a null/empty node for that ticker
   * while its batch peers succeeded (the FSKAX case), or the whole batch failed
   * transiently. Distinct from {@link deferred} (which we deliberately skipped to
   * stay within budget): a failed symbol was tried and couldn't be priced, so it
   * is genuinely stuck rather than merely waiting its turn.
   */
  failed: string[];
  /** A transient failure that forced a fallback, if any. */
  error: PriceError | null;
  /** Credits remaining in the current minute/day windows after this call. */
  minuteRemaining: number;
  dayRemaining: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load quotes for `symbols`, economising on Twelve Data credits.
 *
 * Never throws for a transient failure: callers always get whatever could be
 * sourced (fresh fetch ∪ cache) plus a report describing the gaps. A
 * non-retryable error (e.g. a rejected API key) is surfaced on `report.error`
 * with an empty result so the caller can route the user to Settings.
 */
export async function loadQuotes(
  symbols: string[],
  apiKey: string,
  options: LoadQuotesOptions = {},
): Promise<{ quotes: Map<string, Quote>; report: QuoteLoadReport }> {
  const {
    fetchImpl = fetch,
    storage = undefined,
    now = () => Date.now(),
    sleep = defaultSleep,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cacheTtlMsForSymbol,
    forceMarketFetch = false,
    forceFetch,
    navSymbols,
    creditsPerMinute = FREE_TIER.creditsPerMinute,
    creditsPerDay = FREE_TIER.creditsPerDay,
    maxRetries = 3,
    backoffBaseMs = 1000,
    backoffCapMs = 8000,
  } = options;

  const unique = [...new Set(symbols.filter((s) => s.length > 0))];
  const cache = readCachedQuotes(storage ?? undefined);
  const result = new Map<string, Quote>();
  const servedFresh: string[] = [];
  const stale: string[] = [];

  const t0 = now();
  const ttlFor = (symbol: string, cached?: CachedQuote): number => {
    const override = cacheTtlMsForSymbol?.(symbol, cached);
    return override !== undefined && override > 0 ? override : cacheTtlMs;
  };
  for (const symbol of unique) {
    const cached = cache.get(symbol);
    // A manual "refresh now" forces market symbols to re-fetch even if their
    // cached quote is still inside its window; NAV symbols keep their adaptive
    // (once-a-day) freshness so a tap never wastes credits on an unchanged NAV —
    // unless `forceFetch` opts a specific symbol in (e.g. a NAV that is behind).
    const forced =
      (forceMarketFetch && !(navSymbols?.has(symbol) ?? false)) ||
      (forceFetch?.(symbol, cached) ?? false);
    if (!forced && cached && t0 - cached.at < ttlFor(symbol, cached) && cached.quote.price !== null) {
      result.set(symbol, cached.quote);
      servedFresh.push(symbol);
    } else {
      stale.push(symbol);
    }
  }

  const budget = () => {
    const t = now();
    const log = readCreditLog(t, DAY_MS, storage ?? undefined);
    return {
      minute: Math.max(0, creditsPerMinute - creditsSpentWithin(log, t, MINUTE_MS)),
      day: Math.max(0, creditsPerDay - creditsSpentToday(log, t)),
    };
  };

  const fetched: string[] = [];
  let error: PriceError | null = null;
  // Symbols we actually attempted a live fetch for this call (the budget-affordable
  // slice). Anything in here that doesn't end up freshly priced *failed* — as
  // opposed to a stale symbol we never attempted, which is merely deferred.
  const attempted = new Set<string>();

  const backoffDeps: BackoffDeps = { fetchImpl, sleep, maxRetries, backoffBaseMs, backoffCapMs };

  if (stale.length > 0 && apiKey.length > 0) {
    const { minute, day } = budget();
    // One credit per symbol. Fetch only what both the per-minute and per-day
    // windows can afford right now; the rest is deferred rather than risking a
    // 429. Because `minute` never exceeds the per-minute cap (≤ 8 on the free
    // tier) this is always a single batched call.
    const affordableCount = Math.min(stale.length, minute, day);
    const toFetch = stale.slice(0, affordableCount);
    for (const symbol of toFetch) attempted.add(symbol);

    if (toFetch.length > 0) {
      // Reserve the credits *before* the network call, not after it returns.
      // Two live loads can overlap (the login-time prefetch and the first
      // scheduled refresh share the same caches); if each only recorded its
      // spend on completion, both would read a full per-minute budget and fire
      // a full batch — double-spending straight into an HTTP 429. Recording the
      // spend up-front means whichever load reserves first wins the minute and
      // the other defers, so we stay inside the free-tier cap by construction.
      const reservedAt = now();
      recordCredits(toFetch.length, reservedAt, storage ?? undefined);
      try {
        // Market symbols come from `quote`; NAV funds from the daily
        // `time_series` (authoritative trading-day mark) — see fetchNavQuotes.
        const navBatch = navSymbols ? toFetch.filter((s) => navSymbols.has(s)) : [];
        const marketBatch = navSymbols ? toFetch.filter((s) => !navSymbols.has(s)) : toFetch;
        const quotes = new Map<string, Quote>();
        if (marketBatch.length > 0) {
          for (const [s, q] of await fetchWithBackoff(marketBatch, apiKey, backoffDeps, fetchQuotes)) {
            quotes.set(s, q);
          }
        }
        if (navBatch.length > 0) {
          for (const [s, q] of await fetchWithBackoff(navBatch, apiKey, backoffDeps, fetchNavQuotes)) {
            quotes.set(s, q);
          }
        }
        const at = now();
        // A per-symbol fetch can come back with a null price — a Twelve Data
        // error/empty node for that one ticker while its batch peers succeed
        // (seen on some mutual funds the free tier returns no recent bar for).
        // Never let such a null overwrite a good cached quote: cache and count
        // only the priced results, and leave the unpriced symbols to fall back
        // to their last-known value below (so they keep their real "as of" date
        // and are retried next round, instead of being poisoned to null).
        const priced = new Map<string, Quote>();
        for (const [symbol, q] of quotes) {
          if (q.price !== null) priced.set(symbol, q);
        }
        writeCachedQuotes(priced, at, storage ?? undefined);
        for (const symbol of toFetch) {
          const q = priced.get(symbol);
          if (q) {
            // Stamp the observation time so the UI can show how fresh it is.
            result.set(symbol, { ...q, at });
            fetched.push(symbol);
          }
        }
      } catch (err) {
        const pe = err instanceof PriceError ? err : new PriceError((err as Error).message);
        if (pe.fatal) {
          // A configuration-level rejection (bad/over-quota key): surface it so
          // the caller can prompt for Settings rather than silently degrading.
          return {
            quotes: new Map(),
            report: { fetched: [], servedFresh: [], deferred: [], failed: [], error: pe, minuteRemaining: 0, dayRemaining: 0 },
          };
        }
        error = pe; // transient/non-fatal — keep what we have, fall back for the rest.
      }
    }
  }

  // Anything still stale falls back to its last cached value (even if expired),
  // so totals stay populated; symbols absent from cache are left to the export's
  // last-known price downstream in compute.ts. Split the leftovers honestly: a
  // symbol we *attempted* but couldn't price this call is `failed` (genuinely
  // stuck — e.g. a fund the provider returns no bar for), while one we never
  // attempted because the per-minute/day budget was spent is merely `deferred`.
  const deferred: string[] = [];
  const failed: string[] = [];
  for (const symbol of stale) {
    if (result.has(symbol)) continue;
    const cached = cache.get(symbol);
    if (cached && cached.quote.price !== null) result.set(symbol, cached.quote);
    if (attempted.has(symbol)) failed.push(symbol);
    else deferred.push(symbol);
  }

  const remaining = budget();
  return {
    quotes: result,
    report: {
      fetched,
      servedFresh,
      deferred,
      failed,
      error,
      minuteRemaining: remaining.minute,
      dayRemaining: remaining.day,
    },
  };
}

interface BackoffDeps {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  maxRetries: number;
  backoffBaseMs: number;
  backoffCapMs: number;
}

/** FX rates don't cost Twelve Data credits, but Frankfurter updates only daily. */
export const DEFAULT_FX_TTL_MS = 12 * 60 * 60 * 1000;

export interface LoadFxOptions {
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Load EUR-based FX rates, preferring a still-fresh cache and falling back to
 * the last cached snapshot if the service is unreachable. Returns `error` when
 * neither a live nor a cached rate set is available.
 */
export async function loadFxRates(
  options: LoadFxOptions = {},
): Promise<{ fx: FxRates; cached: boolean; error: PriceError | null }> {
  const { fetchImpl = fetch, storage = undefined, now = () => Date.now(), ttlMs = DEFAULT_FX_TTL_MS } = options;
  const cached = readCachedFx(storage ?? undefined);
  if (cached && now() - cached.at < ttlMs) return { fx: cached.fx, cached: true, error: null };
  try {
    const fx = await fetchFxRates("EUR", fetchImpl);
    writeCachedFx(fx, now(), storage ?? undefined);
    return { fx, cached: false, error: null };
  } catch (err) {
    const pe = err instanceof PriceError ? err : new PriceError((err as Error).message, { retryable: true });
    if (cached) return { fx: cached.fx, cached: true, error: pe };
    return { fx: { base: "EUR", rates: {} }, cached: false, error: pe };
  }
}

/**
 * Freshness window for the live EUR/USD spot. Short enough to track intraday FX
 * developments, long enough to barely touch the free-tier budget (one credit
 * per refresh at most).
 */
export const DEFAULT_EURUSD_TTL_MS = 15 * MINUTE_MS;

/** Where a {@link loadEurUsd} reading came from. */
export type EurUsdSource = "live" | "tiingo" | "eod" | "cache" | "none";

export interface LoadEurUsdResult {
  /** Units of USD per 1 EUR, the current mark (null when wholly unavailable). */
  now: Decimal | null;
  /**
   * Units of USD per 1 EUR at the prior session close, for the FX-aware
   * today's-move prior mark. Null when only an end-of-day rate is available
   * (the ECB fallback carries no separate prior close).
   */
  previousClose: Decimal | null;
  /** Provenance of the figures, so the UI can label end-of-day FX honestly. */
  source: EurUsdSource;
  /**
   * Epoch-ms the `now` rate was observed (a live/Tiingo pull's moment, or when a
   * cached reading was originally stored). Null for the keyless end-of-day ECB
   * rate, which carries no intraday timestamp, and when no rate is available.
   */
  at: number | null;
  cached: boolean;
  error: PriceError | null;
}

export interface LoadEurUsdOptions {
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
  now?: () => number;
  ttlMs?: number;
  creditsPerMinute?: number;
  creditsPerDay?: number;
  /**
   * The end-of-day ECB EUR→USD rate already loaded by {@link loadFxRates},
   * reused as the keyless fallback when the live pair can't be fetched (no
   * budget, no key, or a transient failure). Passing it here avoids a duplicate
   * Frankfurter round-trip.
   */
  eodFallback?: Decimal | null;
  /**
   * The resolved `/price` Worker URL, enabling the **Tiingo** secondary FX
   * provider. When Twelve Data (primary) can't deliver a fresh live spot — no
   * key, budget spent, a transient failure, or a null reading — and we have no
   * fresh same-day cache, Tiingo's `eurusd` mid is tried (one call, charged to
   * the same ET-reset web Tiingo budget) *before* dropping to the flat ECB
   * end-of-day rate. Null/omitted disables the backup (a vanilla setup).
   */
  tiingoProxyUrl?: string | null;
  /** Injectable fetch for the Tiingo FX call (defaults to {@link fetchImpl}). */
  tiingoFetchImpl?: FetchLike;
}

/**
 * Are two epoch-ms instants on the same UTC calendar day? Used to decide whether
 * a cached EUR/USD reading is still "from today" — matching the UTC day boundary
 * the today's-move logic uses (`todayIso`), so the FX mark and the move it feeds
 * agree on what counts as today.
 */
function isSameUtcDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Load the live EUR→USD pair (current spot + prior close) for an FX-aware
 * today's move. Order of preference:
 *   1. a still-fresh cached reading (zero credits),
 *   2. a live Twelve Data `quote` on `EUR/USD` (one credit, budget-permitting),
 *   3. the **Tiingo** secondary FX provider's `eurusd` mid (one Tiingo call via
 *      the `/price` Worker, budget-permitting) — a genuine live spot when the
 *      primary couldn't deliver; it carries no prior close, so today's cached
 *      prior close (if any) is reused alongside it,
 *   4. a cached reading from *today* even if past its TTL — keep using today's
 *      real intraday spot + prior close rather than collapsing to end-of-day,
 *   5. the end-of-day ECB rate from {@link loadFxRates} (`eodFallback`) — no
 *      prior close, so callers fall back to the FX-unaware move,
 *   6. the last cached reading even if from before today,
 * degrading gracefully at every step rather than dead-ending the screen.
 */
export async function loadEurUsd(
  apiKey: string,
  options: LoadEurUsdOptions = {},
): Promise<LoadEurUsdResult> {
  const {
    fetchImpl = fetch,
    storage = undefined,
    now = () => Date.now(),
    ttlMs = DEFAULT_EURUSD_TTL_MS,
    creditsPerMinute = FREE_TIER.creditsPerMinute,
    creditsPerDay = FREE_TIER.creditsPerDay,
    eodFallback = null,
    tiingoProxyUrl = null,
    tiingoFetchImpl,
  } = options;

  const cached = readCachedEurUsd(storage ?? undefined);
  if (cached && cached.now !== null && now() - cached.at < ttlMs) {
    return { now: cached.now, previousClose: cached.previousClose, source: "cache", at: cached.at, cached: true, error: null };
  }

  let liveError: PriceError | null = null;
  if (apiKey.length > 0) {
    const t = now();
    const log = readCreditLog(t, DAY_MS, storage ?? undefined);
    const minute = Math.max(0, creditsPerMinute - creditsSpentWithin(log, t, MINUTE_MS));
    const day = Math.max(0, creditsPerDay - creditsSpentToday(log, t));
    if (minute >= FREE_TIER.creditsPerSymbol && day >= FREE_TIER.creditsPerSymbol) {
      // Reserve the credit up-front (same rationale as loadQuotes) so two
      // overlapping loads can't both fire and 429.
      recordCredits(FREE_TIER.creditsPerSymbol, now(), storage ?? undefined);
      try {
        const reading: EurUsdQuote = await fetchEurUsd(apiKey, fetchImpl);
        if (reading.now !== null) {
          const at = now();
          writeCachedEurUsd(reading, at, storage ?? undefined);
          return { now: reading.now, previousClose: reading.previousClose, source: "live", at, cached: false, error: null };
        }
      } catch (err) {
        liveError = err instanceof PriceError ? err : new PriceError((err as Error).message, { retryable: true });
      }
    }
  }

  // Tiingo secondary FX provider: the primary couldn't deliver a fresh spot (no
  // key, budget spent, a transient failure, or a null reading). One Tiingo call
  // via the `/price` Worker, charged to the same ET-reset web Tiingo budget
  // (40/hr · 800/day). Tiingo carries no prior close, so reuse today's cached
  // one for an FX-aware move when available. Best-effort: never throws here.
  if (tiingoProxyUrl) {
    const t = now();
    const log = readTiingoCreditLog(t, undefined, storage ?? undefined);
    const budget = new Budget(
      creditsSpentWithin(log, t, MINUTE_MS * 60),
      tiingoCreditsSpentToday(log, t),
      WEB_HOURLY_CAP,
      WEB_DAILY_CAP,
    );
    if (budget.hasRoom()) {
      recordTiingoCredits(1, t, storage ?? undefined);
      try {
        const reading = await fetchTiingoEurUsd(tiingoProxyUrl, {
          fetchImpl: tiingoFetchImpl ?? fetchImpl,
        });
        if (reading && reading.now.greaterThan(0)) {
          const at = now();
          const prevClose = cached && isSameUtcDay(cached.at, at) ? cached.previousClose : null;
          const observedAt = reading.at ?? at;
          writeCachedEurUsd({ now: reading.now, previousClose: prevClose }, observedAt, storage ?? undefined);
          return { now: reading.now, previousClose: prevClose, source: "tiingo", at: observedAt, cached: false, error: liveError };
        }
      } catch (err) {
        // A transient backup failure is non-fatal: record it on `error` and keep
        // degrading to the cache / EOD rate below, never dead-ending the screen.
        liveError = err instanceof PriceError ? err : new PriceError((err as Error).message, { retryable: true });
      }
    }
  }

  // Prefer a cached live reading from *today* over the end-of-day ECB rate.
  // An expired-but-same-day cache still carries a genuine intraday spot and a
  // real prior close, so it is a far better mark than collapsing to the flat
  // end-of-day fallback (which has no prior close). Only drop to end-of-day
  // when we have nothing from today at all.
  if (cached && cached.now !== null && isSameUtcDay(cached.at, now())) {
    return { now: cached.now, previousClose: cached.previousClose, source: "cache", at: cached.at, cached: true, error: liveError };
  }

  // Fall back to the end-of-day ECB rate (keyless, no prior close).
  if (eodFallback !== null && eodFallback.greaterThan(0)) {
    return { now: eodFallback, previousClose: null, source: "eod", at: null, cached: false, error: liveError };
  }
  // Last resort: a stale (pre-today) cached reading keeps the spot populated.
  if (cached && cached.now !== null) {
    return { now: cached.now, previousClose: cached.previousClose, source: "cache", at: cached.at, cached: true, error: liveError };
  }
  return { now: null, previousClose: null, source: "none", at: null, cached: false, error: liveError };
}

/** Fetch one batch, retrying a transient failure with capped exponential backoff. */
async function fetchWithBackoff(
  batch: string[],
  apiKey: string,
  deps: BackoffDeps,
  fetcher: (batch: string[], apiKey: string, fetchImpl: FetchLike) => Promise<Map<string, Quote>> = fetchQuotes,
): Promise<Map<string, Quote>> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetcher(batch, apiKey, deps.fetchImpl);
    } catch (err) {
      const pe = err instanceof PriceError ? err : null;
      if (!pe || !pe.retryable || attempt >= deps.maxRetries) throw err;
      const backoff = Math.min(deps.backoffCapMs, deps.backoffBaseMs * 2 ** attempt);
      // Prefer the server's advice, then our schedule, plus jitter to de-sync.
      const wait = (pe.retryAfterMs ?? backoff) + Math.floor(Math.random() * BACKOFF_JITTER_MS);
      await deps.sleep(wait);
      attempt += 1;
    }
  }
}
