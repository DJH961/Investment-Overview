/**
 * localStorage-backed persistence for the free-tier-aware live-data layer.
 *
 * The Twelve Data free plan grants only **8 API credits per minute** and **800
 * per day**, and a batched `/quote` call spends **one credit per symbol**. To
 * live comfortably inside that budget the companion:
 *   - caches quotes + FX so a tab reload, currency toggle, or quick re-open does
 *     not re-spend credits (see {@link readCachedQuotes}/{@link writeCachedQuotes}),
 *   - keeps a rolling log of credits spent so it can throttle itself across
 *     reloads (see {@link readCreditLog}/{@link recordCredits}).
 *
 * Everything here is best-effort: in private mode (or with storage disabled)
 * reads return empty and writes are silently dropped, so the app still works —
 * it just cannot economise on credits.
 */

import { Decimal } from "./decimal-config";
import type { FxRates, Quote } from "./prices";

/** Subset of the Web Storage API we depend on (injectable for tests). */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const QUOTE_KEY = "iv.web.quote_cache";
const FX_KEY = "iv.web.fx_cache";
const CREDIT_KEY = "iv.web.credit_log";

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson<T>(storage: StorageLike | null, key: string): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be full or unavailable; caching is best-effort. */
  }
}

function toDecimal(value: string | null): Decimal | null {
  if (value === null) return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

// --- Quote cache ------------------------------------------------------------

interface StoredQuote {
  price: string | null;
  previousClose: string | null;
  currency: string | null;
  /** Epoch ms when this quote was fetched. */
  at: number;
}

type QuoteCacheFile = Record<string, StoredQuote>;

/** A cached quote together with the moment it was stored. */
export interface CachedQuote {
  quote: Quote;
  at: number;
}

/** Read every cached quote, keyed by symbol. Missing/corrupt cache → empty map. */
export function readCachedQuotes(storage: StorageLike | null = defaultStorage()): Map<string, CachedQuote> {
  const file = readJson<QuoteCacheFile>(storage, QUOTE_KEY) ?? {};
  const out = new Map<string, CachedQuote>();
  for (const [symbol, stored] of Object.entries(file)) {
    if (!stored || typeof stored.at !== "number") continue;
    out.set(symbol, {
      at: stored.at,
      quote: {
        symbol,
        price: toDecimal(stored.price),
        previousClose: toDecimal(stored.previousClose),
        currency: stored.currency,
        at: stored.at,
      },
    });
  }
  return out;
}

/**
 * Merge freshly-fetched quotes into the cache, stamped at `at`. Only symbols
 * that actually carry a price are stored, so a transient null does not clobber
 * a good earlier value.
 */
export function writeCachedQuotes(
  fresh: Map<string, Quote>,
  at: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (fresh.size === 0) return;
  const file = readJson<QuoteCacheFile>(storage, QUOTE_KEY) ?? {};
  for (const [symbol, quote] of fresh) {
    if (quote.price === null) continue;
    file[symbol] = {
      price: quote.price.toString(),
      previousClose: quote.previousClose ? quote.previousClose.toString() : null,
      currency: quote.currency,
      at,
    };
  }
  writeJson(storage, QUOTE_KEY, file);
}

// --- FX cache ---------------------------------------------------------------

interface StoredFx {
  base: string;
  rates: Record<string, string>;
  at: number;
}

/** A cached FX snapshot together with the moment it was stored. */
export interface CachedFx {
  fx: FxRates;
  at: number;
}

export function readCachedFx(storage: StorageLike | null = defaultStorage()): CachedFx | null {
  const stored = readJson<StoredFx>(storage, FX_KEY);
  if (!stored || typeof stored.at !== "number" || !stored.rates) return null;
  const rates: Record<string, Decimal> = {};
  for (const [code, value] of Object.entries(stored.rates)) {
    const dec = toDecimal(value);
    if (dec) rates[code] = dec;
  }
  return { at: stored.at, fx: { base: stored.base, rates } };
}

export function writeCachedFx(
  fx: FxRates,
  at: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  const rates: Record<string, string> = {};
  for (const [code, dec] of Object.entries(fx.rates)) rates[code] = dec.toString();
  writeJson(storage, FX_KEY, { base: fx.base, rates, at });
}

// --- Credit-spend log (rolling-window budget bookkeeping) -------------------

/** A single recorded spend of `n` API credits at epoch-ms `at`. */
export interface CreditSpend {
  at: number;
  n: number;
}

/**
 * Read the credit-spend log, dropping entries older than `keepMs` (defaults to
 * a day, matching the free-tier daily window) so it never grows unbounded.
 */
export function readCreditLog(
  now: number,
  keepMs = 24 * 60 * 60 * 1000,
  storage: StorageLike | null = defaultStorage(),
): CreditSpend[] {
  const raw = readJson<CreditSpend[]>(storage, CREDIT_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e.at === "number" && typeof e.n === "number" && now - e.at < keepMs);
}

/** Append a spend of `n` credits at `now` and persist the pruned log. */
export function recordCredits(
  n: number,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (n <= 0) return;
  const log = readCreditLog(now, 24 * 60 * 60 * 1000, storage);
  log.push({ at: now, n });
  writeJson(storage, CREDIT_KEY, log);
}

/** Sum the credits spent within the trailing `windowMs` up to `now`. */
export function creditsSpentWithin(log: CreditSpend[], now: number, windowMs: number): number {
  return log.reduce((acc, e) => (now - e.at < windowMs ? acc + e.n : acc), 0);
}

export const CACHE_KEYS = { QUOTE_KEY, FX_KEY, CREDIT_KEY } as const;
