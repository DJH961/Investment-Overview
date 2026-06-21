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
  readCachedFx,
  readCachedQuotes,
  readCreditLog,
  recordCredits,
  writeCachedFx,
  writeCachedQuotes,
  type CachedQuote,
  type StorageLike,
} from "./cache";
import {
  fetchFxRates,
  fetchQuotes,
  PriceError,
  type FetchLike,
  type FxRates,
  type Quote,
} from "./prices";

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
 * Freshness window for NAV-priced holdings (mutual funds / money-market).
 * Their NAV publishes only ~once per business day, so a long window keeps the
 * latest available value on screen while barely touching the free-tier budget.
 */
export const DEFAULT_NAV_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Local hour (0–23) by which a fund's once-a-day NAV is expected to be
 * published, used only as the *bootstrap* default before we've learned the
 * fund's real habit (see {@link navPublishWindow}). It defaults to the European
 * market close (~22:00): for a EUR-listed fund the NAV can't strike until the
 * underlying market shuts, so an earlier guess just burns credits polling for a
 * price that cannot exist yet.
 */
export const NAV_PUBLISH_HOUR = 22;

/**
 * How many hours after {@link NAV_PUBLISH_HOUR} the refresh layer keeps polling
 * hard for a not-yet-seen NAV before relaxing again. Bounds the credit cost of
 * a fund that publishes late (or skips a day) to one evening window.
 */
export const NAV_CATCHUP_WINDOW_HOURS = 2;

/**
 * Trailing slack (hours) added past the latest *observed* publish time when
 * deriving a learned window, so an occasional late NAV is still caught.
 */
export const NAV_PUBLISH_LAG_HOURS = 1;

/** Tunables for {@link navCacheTtlMs} (all optional; sensible defaults apply). */
export interface NavRefreshOptions {
  /** Wall-clock epoch ms; defaults to {@link Date.now}. Injected in tests. */
  now?: number;
  /** Local hour the NAV is expected to publish; see {@link NAV_PUBLISH_HOUR}. */
  publishHour?: number;
  /** Hours after `publishHour` to keep polling; see {@link NAV_CATCHUP_WINDOW_HOURS}. */
  catchUpWindowHours?: number;
  /** TTL while catching up to a fresh NAV (poll cadence). */
  shortTtlMs?: number;
  /** TTL once the latest NAV is in hand, or outside the publish window. */
  longTtlMs?: number;
}

/** Is `d` (in local time) a weekday a fund could publish a NAV on? */
function isBusinessDay(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The most recent business day (`YYYY-MM-DD`, local time) whose NAV should
 * already be published as of `now`: today once we're past `publishHour` on a
 * business day, otherwise the previous business day.
 */
export function latestExpectedNavDate(now: Date, publishHour = NAV_PUBLISH_HOUR): string {
  const d = new Date(now);
  if (isBusinessDay(d) && d.getHours() >= publishHour) return localYmd(d);
  do {
    d.setDate(d.getDate() - 1);
  } while (!isBusinessDay(d));
  return localYmd(d);
}

/** Are we currently inside today's "catch the new NAV" polling window? */
function withinCatchUpWindow(now: Date, publishHour: number, windowHours: number): boolean {
  if (!isBusinessDay(now)) return false;
  const hour = now.getHours() + now.getMinutes() / 60;
  return hour >= publishHour && hour < Math.min(24, publishHour + windowHours);
}

/**
 * Adaptive freshness window for a NAV-priced holding. Funds publish their NAV
 * only ~once per business day, so polling on a fixed short interval all day
 * wastes the free-tier budget while a fixed long interval can leave today's
 * fresh NAV unseen for hours.
 *
 * This returns a short (poll-often) TTL only when we are *both* inside the
 * evening publish window *and* still missing the latest expected NAV (judged by
 * the cached quote's value-date). Once that NAV lands — or outside the window —
 * it relaxes to the long window so refreshes barely touch the credit budget.
 */
export function navCacheTtlMs(
  cached: { valueDate?: string | null } | null | undefined,
  options: NavRefreshOptions = {},
): number {
  const {
    now = Date.now(),
    publishHour = NAV_PUBLISH_HOUR,
    catchUpWindowHours = NAV_CATCHUP_WINDOW_HOURS,
    shortTtlMs = DEFAULT_CACHE_TTL_MS,
    longTtlMs = DEFAULT_NAV_CACHE_TTL_MS,
  } = options;

  const nowDate = new Date(now);
  const have = cached?.valueDate ?? null;
  // Already holding the latest expected NAV: nothing new to chase.
  if (have && have >= latestExpectedNavDate(nowDate, publishHour)) return longTtlMs;
  // Missing it — poll hard only during the evening publish window.
  if (withinCatchUpWindow(nowDate, publishHour, catchUpWindowHours)) return shortTtlMs;
  return longTtlMs;
}

/** A NAV polling window: when to start, and for how many hours to keep at it. */
export interface NavWindow {
  /** Local hour the catch-up polling window opens (also the "expected by" gate). */
  publishHour: number;
  /** Hours the window stays open past {@link publishHour}. */
  catchUpWindowHours: number;
}

/**
 * Derive a fund's NAV polling window from the local hours at which its NAV
 * value-date was actually observed to advance (see {@link recordNavPublish}).
 *
 * Rather than a fixed evening guess, the window brackets the observed publish
 * times: it opens at the start of the earliest hour a new NAV has landed and
 * stays open until just past the latest, plus a little slack
 * ({@link NAV_PUBLISH_LAG_HOURS}) for the odd late day. With no observations yet
 * it falls back to the {@link NAV_PUBLISH_HOUR}/{@link NAV_CATCHUP_WINDOW_HOURS}
 * bootstrap defaults. The result is a tighter, fund-specific window that wastes
 * fewer credits polling for a price that cannot exist yet.
 */
export function navPublishWindow(observedHours?: readonly number[] | null): NavWindow {
  const hours = (observedHours ?? []).filter((h) => Number.isFinite(h) && h >= 0 && h <= 24);
  if (hours.length === 0) {
    return { publishHour: NAV_PUBLISH_HOUR, catchUpWindowHours: NAV_CATCHUP_WINDOW_HOURS };
  }
  const start = Math.min(23, Math.max(0, Math.floor(Math.min(...hours))));
  const end = Math.min(24, Math.ceil(Math.max(...hours)) + NAV_PUBLISH_LAG_HOURS);
  return { publishHour: start, catchUpWindowHours: Math.max(1, end - start) };
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
   * Called when a freshly-fetched symbol reports a value-date later than the one
   * already cached (or has none cached yet). Lets callers learn *when* a fund's
   * once-a-day NAV actually lands; see {@link navPublishWindow}. `at` is the
   * fetch time, suitable for {@link recordNavPublish}.
   */
  onValueDateAdvance?: (symbol: string, valueDate: string, at: number) => void;
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
    onValueDateAdvance,
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
    if (cached && t0 - cached.at < ttlFor(symbol, cached) && cached.quote.price !== null) {
      result.set(symbol, cached.quote);
      servedFresh.push(symbol);
    } else {
      stale.push(symbol);
    }
  }

  const budget = () => {
    const log = readCreditLog(now(), DAY_MS, storage ?? undefined);
    return {
      minute: Math.max(0, creditsPerMinute - creditsSpentWithin(log, now(), MINUTE_MS)),
      day: Math.max(0, creditsPerDay - creditsSpentWithin(log, now(), DAY_MS)),
    };
  };

  const fetched: string[] = [];
  let error: PriceError | null = null;

  if (stale.length > 0 && apiKey.length > 0) {
    const { minute, day } = budget();
    // One credit per symbol. Fetch only what both the per-minute and per-day
    // windows can afford right now; the rest is deferred rather than risking a
    // 429. Because `minute` never exceeds the per-minute cap (≤ 8 on the free
    // tier) this is always a single batched call.
    const affordableCount = Math.min(stale.length, minute, day);
    const toFetch = stale.slice(0, affordableCount);

    if (toFetch.length > 0) {
      try {
        const quotes = await fetchWithBackoff(toFetch, apiKey, {
          fetchImpl,
          sleep,
          maxRetries,
          backoffBaseMs,
          backoffCapMs,
        });
        const at = now();
        writeCachedQuotes(quotes, at, storage ?? undefined);
        recordCredits(toFetch.length, at, storage ?? undefined);
        for (const symbol of toFetch) {
          const q = quotes.get(symbol);
          if (q) {
            // Stamp the observation time so the UI can show how fresh it is.
            result.set(symbol, { ...q, at });
            fetched.push(symbol);
            // Notify when this symbol's NAV value-date has moved on, so callers
            // can learn the fund's real publish window.
            if (onValueDateAdvance && q.valueDate) {
              const prev = cache.get(symbol)?.quote.valueDate ?? null;
              if (!prev || q.valueDate > prev) onValueDateAdvance(symbol, q.valueDate, at);
            }
          }
        }
      } catch (err) {
        const pe = err instanceof PriceError ? err : new PriceError((err as Error).message);
        if (!pe.retryable) {
          // A config-level rejection (bad/over-quota key): surface it so the
          // caller can prompt for Settings rather than silently degrading.
          return {
            quotes: new Map(),
            report: { fetched: [], servedFresh: [], deferred: [], error: pe, minuteRemaining: 0, dayRemaining: 0 },
          };
        }
        error = pe; // transient — keep what we have, fall back for the rest.
      }
    }
  }

  // Anything still stale falls back to its last cached value (even if expired),
  // so totals stay populated; symbols absent from cache are left to the export's
  // last-known price downstream in compute.ts.
  const deferred: string[] = [];
  for (const symbol of stale) {
    if (result.has(symbol)) continue;
    const cached = cache.get(symbol);
    if (cached && cached.quote.price !== null) result.set(symbol, cached.quote);
    deferred.push(symbol);
  }

  const remaining = budget();
  return {
    quotes: result,
    report: {
      fetched,
      servedFresh,
      deferred,
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

/** Fetch one batch, retrying a transient failure with capped exponential backoff. */
async function fetchWithBackoff(
  batch: string[],
  apiKey: string,
  deps: BackoffDeps,
): Promise<Map<string, Quote>> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchQuotes(batch, apiKey, deps.fetchImpl);
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
