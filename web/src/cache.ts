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
import type { Envelope } from "./crypto";
import type { FxRates, Quote } from "./prices";

/** Subset of the Web Storage API we depend on (injectable for tests). */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const QUOTE_KEY = "iv.web.quote_cache";
const FX_KEY = "iv.web.fx_cache";
const CREDIT_KEY = "iv.web.credit_log";
const BLOB_KEY = "iv.web.blob_cache";

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
  /** Trading day the price applies to (`YYYY-MM-DD`); see {@link Quote.valueDate}. */
  valueDate?: string | null;
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
        valueDate: stored.valueDate ?? null,
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
      valueDate: quote.valueDate ?? null,
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

// --- Encrypted-blob cache ---------------------------------------------------

/** A cached encrypted envelope together with the moment it was downloaded. */
export interface CachedEnvelope {
  envelope: Envelope;
  at: number;
}

/**
 * Read the last-downloaded encrypted envelope, if any. The envelope is opaque
 * AES-256-GCM ciphertext — exactly the public, safe-to-serve blob — so caching
 * it locally leaks nothing: it can only be decrypted with the passphrase, which
 * is never stored. Caching it lets the app decrypt the copy it already has
 * *first* (instant unlock) and only then re-download a fresh blob in the
 * background. Missing/corrupt cache → null.
 */
export function readCachedEnvelope(storage: StorageLike | null = defaultStorage()): CachedEnvelope | null {
  const stored = readJson<{ envelope: Envelope; at: number }>(storage, BLOB_KEY);
  if (!stored || typeof stored.at !== "number" || typeof stored.envelope !== "object" || stored.envelope === null) {
    return null;
  }
  return { envelope: stored.envelope, at: stored.at };
}

/** Persist the encrypted envelope downloaded at `at` (best-effort). */
export function writeCachedEnvelope(
  envelope: Envelope,
  at: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  writeJson(storage, BLOB_KEY, { envelope, at });
}



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

// --- Learned NAV publish times ---------------------------------------------

const NAV_PUBLISH_KEY = "iv.web.nav_publish";

/**
 * How many recent NAV publishes to remember per symbol. A few weeks of business
 * days is plenty to pin down a fund's habitual publish window without letting a
 * one-off late day skew it forever.
 */
export const NAV_PUBLISH_SAMPLES = 16;

/**
 * What we've observed about *when* a given fund's once-a-day NAV actually lands.
 * The refresh layer compares each fresh quote's value-date against the last one
 * we recorded; when it advances we log the local hour we first saw the new NAV,
 * building an empirical picture of the fund's real publish window instead of a
 * fixed guess.
 */
export interface NavPublishStat {
  /** Most recent value-date (`YYYY-MM-DD`) we've recorded for this symbol. */
  lastValueDate: string;
  /**
   * Local clock hours (fractional, e.g. `22.25` for 22:15) at which the most
   * recent value-date flips were first observed, oldest first, newest last.
   */
  hours: number[];
}

type NavPublishFile = Record<string, NavPublishStat>;

/** Read the learned NAV publish-time stats, keyed by symbol. */
export function readNavPublishStats(storage: StorageLike | null = defaultStorage()): Map<string, NavPublishStat> {
  const file = readJson<NavPublishFile>(storage, NAV_PUBLISH_KEY) ?? {};
  const out = new Map<string, NavPublishStat>();
  for (const [symbol, stat] of Object.entries(file)) {
    if (!stat || typeof stat.lastValueDate !== "string" || !Array.isArray(stat.hours)) continue;
    const hours = stat.hours.filter((h) => typeof h === "number" && h >= 0 && h <= 24);
    out.set(symbol, { lastValueDate: stat.lastValueDate, hours });
  }
  return out;
}

/**
 * Note that `symbol` now reports NAV value-date `valueDate`, first seen at epoch
 * `at`. Only a *new* (later) value-date is recorded — a repeat of the value-date
 * we already hold is not a fresh publish and is ignored — so the stored hours
 * track when this fund's NAV genuinely becomes available. Best-effort: storage
 * failures are swallowed, matching the rest of this module.
 */
export function recordNavPublish(
  symbol: string,
  valueDate: string,
  at: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!symbol || !valueDate) return;
  const file = readJson<NavPublishFile>(storage, NAV_PUBLISH_KEY) ?? {};
  const existing = file[symbol];
  // Only a strictly-later value-date counts as a fresh publish to time.
  if (existing && existing.lastValueDate >= valueDate) return;
  const d = new Date(at);
  const hour = d.getHours() + d.getMinutes() / 60;
  const hours = [...(existing?.hours ?? []), hour].slice(-NAV_PUBLISH_SAMPLES);
  file[symbol] = { lastValueDate: valueDate, hours };
  writeJson(storage, NAV_PUBLISH_KEY, file);
}

export const CACHE_KEYS = { QUOTE_KEY, FX_KEY, CREDIT_KEY, NAV_PUBLISH_KEY, BLOB_KEY } as const;
