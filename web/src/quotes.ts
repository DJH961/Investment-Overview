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

/** Default freshness window before a cached quote is considered stale. */
export const DEFAULT_CACHE_TTL_MS = 15 * MINUTE_MS;

/** Tunables + injectable seams (tests supply deterministic clock/sleep/storage). */
export interface LoadQuotesOptions {
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a cached quote stays fresh; older entries are re-fetched. */
  cacheTtlMs?: number;
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
  for (const symbol of unique) {
    const cached = cache.get(symbol);
    if (cached && t0 - cached.at < cacheTtlMs && cached.quote.price !== null) {
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
    const affordable = Math.min(stale.length, minute, day);
    const toFetch = stale.slice(0, affordable);

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
            result.set(symbol, q);
            fetched.push(symbol);
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
      const wait = (pe.retryAfterMs ?? backoff) + Math.floor(Math.random() * 250);
      await deps.sleep(wait);
      attempt += 1;
    }
  }
}
