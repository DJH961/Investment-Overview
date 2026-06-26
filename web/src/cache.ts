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
import type { Bar } from "./timeseries";

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
  /**
   * Epoch ms the price actually applies to (Twelve Data `timestamp`); see
   * {@link Quote.priceTime}. Optional for backward compatibility with caches
   * written before this field existed.
   */
  priceTime?: number | null;
  /** Trading day the price applies to (`YYYY-MM-DD`); see {@link Quote.valueDate}. */
  valueDate?: string | null;
  /** Provider market-state flag at fetch time; see {@link Quote.marketOpen}. */
  marketOpen?: boolean | null;
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
        priceTime: stored.priceTime ?? null,
        valueDate: stored.valueDate ?? null,
        marketOpen: stored.marketOpen ?? null,
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
      priceTime: quote.priceTime ?? null,
      valueDate: quote.valueDate ?? null,
      marketOpen: quote.marketOpen ?? null,
    };
  }
  writeJson(storage, QUOTE_KEY, file);
}

/**
 * Prime the quote cache from a graph's freshly fetched native price bars.
 *
 * When a 1D/1W graph build pays to fetch price bars, each symbol's newest bar is
 * a current native mark — the very figure a holding row would otherwise spend its
 * own credit on. Folding it back into the quote cache lets the holdings reuse it
 * instead of re-requesting it.
 *
 * It only ever **extends** freshness, never rewrites history: a symbol is primed
 * only when its newest bar is strictly newer than the cached quote's price
 * instant (`priceTime`, falling back to `at`), so a genuine, fresher quote is
 * never clobbered by an older bar. Bars carry no currency or prior close, so the
 * cached `currency`/`previousClose` are preserved; when the symbol is uncached,
 * the caller-supplied native currency seeds it (and without any currency the
 * symbol is skipped, since its value could not be denominated safely). `at` is
 * stamped at `now` because the bar was just fetched — honest fetch-freshness —
 * while `priceTime` records the bar's own strike instant.
 */
export function primeQuotesFromBars(
  barsBySymbol: Map<string, Bar[]>,
  currencyBySymbol: Map<string, string | null>,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (barsBySymbol.size === 0) return;
  const file = readJson<QuoteCacheFile>(storage, QUOTE_KEY) ?? {};
  let touched = false;
  for (const [symbol, bars] of barsBySymbol) {
    const latest = latestBar(bars);
    if (latest === null) continue;
    const existing = file[symbol];
    const knownInstant = existing ? (existing.priceTime ?? existing.at) : null;
    // Only ever move freshness forward — never overwrite a newer genuine quote.
    if (knownInstant !== null && latest.t <= knownInstant) continue;
    const currency = existing?.currency ?? currencyBySymbol.get(symbol) ?? null;
    if (currency === null) continue; // cannot denominate a bare native price safely
    file[symbol] = {
      price: latest.value.toString(),
      previousClose: existing?.previousClose ?? null,
      currency,
      at: now,
      priceTime: latest.t,
      valueDate: existing?.valueDate ?? null,
      marketOpen: existing?.marketOpen ?? null,
    };
    touched = true;
  }
  if (touched) writeJson(storage, QUOTE_KEY, file);
}

/** The newest (largest-`t`) bar in a list, or null when the list is empty. */
function latestBar(bars: Bar[]): Bar | null {
  let best: Bar | null = null;
  for (const bar of bars) {
    if (best === null || bar.t > best.t) best = bar;
  }
  return best;
}

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

// --- Live EUR/USD cache -----------------------------------------------------

const EURUSD_KEY = "iv.web.eurusd_cache";

interface StoredEurUsd {
  now: string | null;
  previousClose: string | null;
  at: number;
}

/** A cached live EUR→USD reading (now + prior close) and when it was stored. */
export interface CachedEurUsd {
  now: Decimal | null;
  previousClose: Decimal | null;
  at: number;
}

/** Read the last cached live EUR→USD reading, or null when none/corrupt. */
export function readCachedEurUsd(storage: StorageLike | null = defaultStorage()): CachedEurUsd | null {
  const stored = readJson<StoredEurUsd>(storage, EURUSD_KEY);
  if (!stored || typeof stored.at !== "number") return null;
  return {
    now: toDecimal(stored.now),
    previousClose: toDecimal(stored.previousClose),
    at: stored.at,
  };
}

/**
 * Persist a live EUR→USD reading stamped at `at` (best-effort). Only written
 * when a current spot is present, so a transient null never clobbers a good
 * earlier reading.
 */
export function writeCachedEurUsd(
  reading: { now: Decimal | null; previousClose: Decimal | null },
  at: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (reading.now === null) return;
  writeJson(storage, EURUSD_KEY, {
    now: reading.now.toString(),
    previousClose: reading.previousClose ? reading.previousClose.toString() : null,
    at,
  });
}

// --- Encrypted-blob cache ---------------------------------------------------

/**
 * HTTP cache validators captured alongside a downloaded blob so the next check
 * can be a *conditional* request (`If-None-Match` / `If-Modified-Since`). When
 * the server answers `304 Not Modified` the companion skips both the download
 * and the decrypt entirely. `metaVersion` is the version stamp from the
 * `portfolio.meta.json` sidecar (see {@link resolveMetaUrl}), an even cheaper
 * "is there a newer export?" signal that the desktop app controls directly.
 */
export interface BlobValidators {
  etag?: string | null;
  lastModified?: string | null;
  metaVersion?: string | null;
}

/** A cached encrypted envelope together with the moment it was downloaded. */
export interface CachedEnvelope {
  envelope: Envelope;
  at: number;
  /** Last `ETag` seen for this blob, or null. */
  etag: string | null;
  /** Last `Last-Modified` seen for this blob, or null. */
  lastModified: string | null;
  /** Last `portfolio.meta.json` version stamp seen, or null. */
  metaVersion: string | null;
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
  const stored = readJson<{
    envelope: Envelope;
    at: number;
    etag?: unknown;
    lastModified?: unknown;
    metaVersion?: unknown;
  }>(storage, BLOB_KEY);
  if (!stored || typeof stored.at !== "number" || typeof stored.envelope !== "object" || stored.envelope === null) {
    return null;
  }
  return {
    envelope: stored.envelope,
    at: stored.at,
    etag: typeof stored.etag === "string" ? stored.etag : null,
    lastModified: typeof stored.lastModified === "string" ? stored.lastModified : null,
    metaVersion: typeof stored.metaVersion === "string" ? stored.metaVersion : null,
  };
}

/**
 * Persist the encrypted envelope downloaded at `at` (best-effort), together with
 * any HTTP validators / meta version so the next refresh can ask the server
 * "has this changed?" instead of blindly re-downloading.
 */
export function writeCachedEnvelope(
  envelope: Envelope,
  at: number,
  validators: BlobValidators = {},
  storage: StorageLike | null = defaultStorage(),
): void {
  writeJson(storage, BLOB_KEY, {
    envelope,
    at,
    etag: validators.etag ?? null,
    lastModified: validators.lastModified ?? null,
    metaVersion: validators.metaVersion ?? null,
  });
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

/**
 * Refund `n` credits previously {@link recordCredits reserved} but not actually
 * billed by the provider (the *settle* half of the two-phase reserve/settle
 * accounting — see `docs/tiingo_polling_storm_cleanup_plan.md` item 1). Booked as
 * a negative spend so the running totals ({@link creditsSpentWithin},
 * {@link creditsSpentToday}) net it back out; concurrent dispatches still saw the
 * worst-case reservation while the call was in flight, so they paced themselves.
 */
export function releaseCredits(
  n: number,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (n <= 0) return;
  const log = readCreditLog(now, 24 * 60 * 60 * 1000, storage);
  log.push({ at: now, n: -n });
  writeJson(storage, CREDIT_KEY, log);
}

/** Sum the credits spent within the trailing `windowMs` up to `now`. */
export function creditsSpentWithin(log: CreditSpend[], now: number, windowMs: number): number {
  return log.reduce((acc, e) => (now - e.at < windowMs ? acc + e.n : acc), 0);
}

/**
 * Epoch ms of the most recent top-of-the-hour (`:00`) at or before `now`.
 *
 * Because a UTC hour is a fixed 3_600_000 ms and every whole-hour timezone shares
 * the same `:00` boundary, flooring to the hour grid lands exactly on the local
 * clock's top of the hour for the device's timezone.
 */
export function startOfHour(now: number): number {
  const HOUR_MS = 60 * 60 * 1000;
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

/**
 * Credits spent so far **this clock hour** (since the most recent `:00`). Unlike
 * a trailing 60-minute window this resets to zero on the hour — at 1:00, 2:00,
 * … — which is the budget cadence the user expects ("rest on the hour, not
 * every hour"): a spend at 1:55 no longer suppresses a fresh allowance at 2:00.
 */
export function creditsSpentThisHour(log: CreditSpend[], now: number): number {
  const hourStart = startOfHour(now);
  return log.reduce((acc, e) => (e.at >= hourStart ? acc + e.n : acc), 0);
}

/**
 * Epoch ms of the most recent 00:00 **UTC** at or before `now`.
 *
 * Twelve Data resets the free-tier *daily* credit allowance at midnight UTC, so
 * the day's spend must be measured from that boundary — not a trailing 24h
 * window. Because the Unix epoch itself begins at 00:00 UTC and a JS day is a
 * fixed 86_400_000 ms (no leap seconds), flooring to the day grid lands exactly
 * on UTC midnight.
 */
export function startOfUtcDay(now: number): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/**
 * Credits spent so far **today** (since the most recent 00:00 UTC), which is the
 * window the free-tier daily cap of 800 actually applies to. Using this instead
 * of a rolling 24h window means a fresh UTC day starts the budget back at zero —
 * last night's spend no longer eats into this morning's allowance.
 */
export function creditsSpentToday(log: CreditSpend[], now: number): number {
  const dayStart = startOfUtcDay(now);
  return log.reduce((acc, e) => (e.at >= dayStart ? acc + e.n : acc), 0);
}

// --- Tiingo fallback budget (ET-reset) -------------------------------------

const TIINGO_CREDIT_KEY = "iv.web.tiingo_credit_log";

/**
 * Epoch ms of the most recent ET (America/New_York) midnight at or before `now`.
 *
 * Tiingo's shared free-tier *daily* allowance resets at midnight **US/Eastern**
 * (not UTC, unlike Twelve Data — see {@link startOfUtcDay}). Because the ET
 * offset shifts with daylight saving, this can't floor to a fixed grid: it reads
 * the actual ET wall-clock parts for `now` and subtracts the elapsed ET
 * time-of-day, landing exactly on ET midnight in either DST phase.
 */
export function startOfEtDay(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(now));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") % 24; // `hour12:false` can render midnight as "24".
  const minute = get("minute");
  const second = get("second");
  const todMs = (hour * 3600 + minute * 60 + second) * 1000 + (now % 1000);
  return now - todMs;
}

/**
 * Read the Tiingo credit-spend log (separate from the Twelve Data one), dropping
 * entries older than `keepMs`. A day's worth of retention is plenty for the
 * hour/day budget windows.
 */
export function readTiingoCreditLog(
  now: number,
  keepMs = 24 * 60 * 60 * 1000,
  storage: StorageLike | null = defaultStorage(),
): CreditSpend[] {
  const raw = readJson<CreditSpend[]>(storage, TIINGO_CREDIT_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e.at === "number" && typeof e.n === "number" && now - e.at < keepMs);
}

/** Append a spend of `n` Tiingo credits at `now` and persist the pruned log. */
export function recordTiingoCredits(
  n: number,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (n <= 0) return;
  const log = readTiingoCreditLog(now, 24 * 60 * 60 * 1000, storage);
  log.push({ at: now, n });
  writeJson(storage, TIINGO_CREDIT_KEY, log);
}

/**
 * Refund `n` Tiingo credits previously {@link recordTiingoCredits reserved} but
 * not actually forwarded to Tiingo by the Worker (e.g. a Worker-side `400`/`429`/
 * `502`/`503` reject that never reached Tiingo's meter — see the two-phase
 * accounting in `docs/tiingo_polling_storm_cleanup_plan.md` item 1). Booked as a
 * negative spend so the running total nets it back out. This is what stops the
 * FX-storm failure mode leaving a phantom charge on the ledger.
 */
export function releaseTiingoCredits(
  n: number,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (n <= 0) return;
  const log = readTiingoCreditLog(now, 24 * 60 * 60 * 1000, storage);
  log.push({ at: now, n: -n });
  writeJson(storage, TIINGO_CREDIT_KEY, log);
}

/**
 * Tiingo credits spent so far **today**, measured from the most recent ET
 * midnight — the window Tiingo's shared daily cap actually resets on.
 */
export function tiingoCreditsSpentToday(log: CreditSpend[], now: number): number {
  const dayStart = startOfEtDay(now);
  return log.reduce((acc, e) => (e.at >= dayStart ? acc + e.n : acc), 0);
}

// --- Live-graph time-series backoff (price bars + FX) ----------------------

const SERIES_BACKOFF_KEY = "iv.web.series_backoff";

/**
 * Default cooldown a persistently empty/failing time-series endpoint is
 * suppressed for once it has armed. Wall-clock (epoch-ms) based, so it is
 * measured against the real clock and survives the app being closed and
 * reopened — not "time the app has been open".
 */
export const DEFAULT_SERIES_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How many consecutive failed attempts a series gets *before* the cooldown
 * arms. The app should try hard in a short session, so a symbol is retried this
 * many times across rebuilds; only a genuinely dead series (still failing after
 * the 3rd try) is parked for {@link DEFAULT_SERIES_BACKOFF_MS}.
 */
export const DEFAULT_SERIES_BACKOFF_ATTEMPTS = 3;

/** One series' backoff state: the strike count and when (epoch-ms) it armed. */
export interface SeriesBackoffEntry {
  /** Consecutive failed attempts since the last success / cooldown reset. */
  fails: number;
  /** Epoch-ms the cooldown armed (`fails` reached the threshold), or null. */
  armedAt: number | null;
}

/**
 * Read the backoff state for a time-series `key` (a price symbol like
 * `"1W:AAPL"` or an FX leg like `"fx:1W:1day"`), or null when untracked. Backs
 * the per-symbol negative-result memo (`docs/tiingo_polling_storm_cleanup_plan.md`
 * item 4): a symbol that keeps failing is suppressed from the network so a
 * graph-switch storm cannot re-arm the refill gate on every render — while
 * quotes are never gated, so the headline price still updates.
 */
export function readSeriesBackoff(
  key: string,
  storage: StorageLike | null = defaultStorage(),
): SeriesBackoffEntry | null {
  const raw = readJson<Record<string, SeriesBackoffEntry>>(storage, SERIES_BACKOFF_KEY);
  const entry = raw && typeof raw === "object" ? raw[key] : undefined;
  if (!entry || typeof entry !== "object") return null;
  const fails = typeof entry.fails === "number" && Number.isFinite(entry.fails) ? entry.fails : 0;
  const armedAt =
    typeof entry.armedAt === "number" && Number.isFinite(entry.armedAt) ? entry.armedAt : null;
  return { fails, armedAt };
}

/** Persist the backoff state for a time-series `key`. */
export function writeSeriesBackoff(
  key: string,
  entry: SeriesBackoffEntry,
  storage: StorageLike | null = defaultStorage(),
): void {
  const raw = readJson<Record<string, SeriesBackoffEntry>>(storage, SERIES_BACKOFF_KEY);
  const next: Record<string, SeriesBackoffEntry> =
    raw && typeof raw === "object" ? { ...raw } : {};
  next[key] = entry;
  writeJson(storage, SERIES_BACKOFF_KEY, next);
}

/** Clear one series' backoff state (e.g. after a successful, non-empty pull). */
export function clearSeriesBackoff(
  key: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  const raw = readJson<Record<string, SeriesBackoffEntry>>(storage, SERIES_BACKOFF_KEY);
  if (!raw || typeof raw !== "object" || !(key in raw)) return;
  const next = { ...raw };
  delete next[key];
  writeJson(storage, SERIES_BACKOFF_KEY, next);
}

/**
 * Wipe **all** time-series backoff state. Wired to the Settings hard refreshes
 * (force-fetch-all / backup provider / hard reset) so a deliberate user-driven
 * refresh always re-attempts every symbol immediately, regardless of any armed
 * cooldown — the automatic rebuild loop keeps the storm protection, an explicit
 * tap overrides it.
 */
export function clearAllSeriesBackoff(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  storage.removeItem(SERIES_BACKOFF_KEY);
}

// --- Tiingo NAV canary + quick-refresh state -------------------------------

const TIINGO_STATE_KEY = "iv.web.tiingo_state";

/**
 * Persisted Tiingo-fallback timing state. Every gate is evaluated on *elapsed
 * since a stored stamp*, never a live countdown, so a due probe / quick-refresh
 * fires the instant the app is reopened past its window (the app is rarely left
 * running across the evening NAV-publish window).
 */
export interface TiingoState {
  /** ET day (`YYYY-MM-DD`) the canary counter belongs to; resets at ET midnight. */
  canaryDay: string | null;
  /** Number of canary probes already fired on {@link canaryDay}. */
  canaryCount: number;
  /** Epoch ms of the last canary probe, for the cooldown gate. */
  lastCanaryAt: number | null;
  /** Epoch ms of the last startup quick-refresh, for the ~once/hour throttle. */
  lastQuickRefreshAt: number | null;
}

const EMPTY_TIINGO_STATE: TiingoState = {
  canaryDay: null,
  canaryCount: 0,
  lastCanaryAt: null,
  lastQuickRefreshAt: null,
};

/** Read the persisted Tiingo timing state (canary counters + quick-refresh stamp). */
export function readTiingoState(storage: StorageLike | null = defaultStorage()): TiingoState {
  const raw = readJson<Partial<TiingoState>>(storage, TIINGO_STATE_KEY);
  if (!raw || typeof raw !== "object") return { ...EMPTY_TIINGO_STATE };
  return {
    canaryDay: typeof raw.canaryDay === "string" ? raw.canaryDay : null,
    canaryCount: typeof raw.canaryCount === "number" && raw.canaryCount >= 0 ? raw.canaryCount : 0,
    lastCanaryAt: typeof raw.lastCanaryAt === "number" ? raw.lastCanaryAt : null,
    lastQuickRefreshAt: typeof raw.lastQuickRefreshAt === "number" ? raw.lastQuickRefreshAt : null,
  };
}

/** Persist the Tiingo timing state (best-effort). */
export function writeTiingoState(state: TiingoState, storage: StorageLike | null = defaultStorage()): void {
  writeJson(storage, TIINGO_STATE_KEY, state);
}

// --- Tiingo "no newer data" stamps (per symbol) ----------------------------

const TIINGO_NO_NEWER_KEY = "iv.web.tiingo_no_newer";

/**
 * A record that the backup provider (Tiingo) was asked for a symbol and returned
 * nothing newer than what we already held, while chasing a given target date.
 * Lets the fallback stop re-pulling the same too-old value on every refresh: a
 * mutual fund whose NAV is genuinely days behind shouldn't be re-fetched from
 * the backup each time the user taps Refresh — the backup already confirmed it
 * has nothing fresher for that target.
 */
export interface TiingoNoNewer {
  /** The target session/NAV date we were chasing when the backup came up empty. */
  expected: string;
  /** Epoch ms the empty result was recorded (drives the cooldown). */
  at: number;
}

/** Read the per-symbol "backup has nothing newer" stamps. */
export function readTiingoNoNewer(storage: StorageLike | null = defaultStorage()): Record<string, TiingoNoNewer> {
  const raw = readJson<Record<string, Partial<TiingoNoNewer>>>(storage, TIINGO_NO_NEWER_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, TiingoNoNewer> = {};
  for (const [symbol, v] of Object.entries(raw)) {
    if (v && typeof v.expected === "string" && typeof v.at === "number") {
      out[symbol] = { expected: v.expected, at: v.at };
    }
  }
  return out;
}

/**
 * Record that the backup returned nothing newer for `symbol` while chasing
 * `expected`. Subsequent refreshes consult this (see the fallback's no-newer
 * gate) to avoid re-pulling the same stale value until the cooldown elapses or a
 * newer target appears.
 */
export function recordTiingoNoNewer(
  symbol: string,
  expected: string,
  at: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  const map = readTiingoNoNewer(storage);
  map[symbol] = { expected, at };
  writeJson(storage, TIINGO_NO_NEWER_KEY, map);
}

/**
 * Clear the "nothing newer" stamp for `symbol` — called when the backup (or the
 * primary) finally advances the held value-date, so the next genuine gap re-pulls
 * normally.
 */
export function clearTiingoNoNewer(symbol: string, storage: StorageLike | null = defaultStorage()): void {
  const map = readTiingoNoNewer(storage);
  if (!(symbol in map)) return;
  delete map[symbol];
  writeJson(storage, TIINGO_NO_NEWER_KEY, map);
}

// --- Last successful data pull ---------------------------------------------

const LAST_PULL_KEY = "iv.web.last_pull";

/**
 * Read the epoch-ms timestamp of the last time fresh market data actually
 * landed from the network (a live quote or FX fetch), or null when none has
 * been recorded yet. Persisted so the stamp survives a reload / re-open and is
 * available on the very first (cache-only) paint — letting the UI say *when the
 * data was last pulled* (e.g. "today", "yesterday") regardless of how old the
 * prices themselves are.
 */
export function readLastPull(storage: StorageLike | null = defaultStorage()): number | null {
  const raw = readJson<{ at?: unknown }>(storage, LAST_PULL_KEY);
  return raw && typeof raw.at === "number" ? raw.at : null;
}

/** Persist the last-data-pull timestamp (epoch ms). */
export function writeLastPull(at: number, storage: StorageLike | null = defaultStorage()): void {
  writeJson(storage, LAST_PULL_KEY, { at });
}

// --- Live-data prefetch plan ------------------------------------------------

const SYMBOL_PLAN_KEY = "iv.web.symbol_plan";
const SESSION_STATUS_KEY = "iv.web.session_status";

/**
 * A single symbol the companion knows it will want to price, with just enough
 * context to order and route the fetch *before* the encrypted blob is decrypted.
 * Holds only tickers + coarse sizing — never any decrypted figure or secret.
 */
export interface PlannedSymbol {
  /** The Twelve Data ticker to request. */
  symbol: string;
  /** `market` (ETF/stock) or a NAV class (`mutual_fund`); drives priority. */
  priceType: string;
  /** Asset class, retained for routing (e.g. NAV cache TTL). */
  assetClass: string;
  /** Last-known EUR size, used only to order the fetch (largest first). */
  sizeEur: number;
}

/**
 * Read the cached prefetch plan — the priority-ordered symbols from the last
 * successful refresh. Lets the app start warming live quotes at login, before
 * the blob is even decrypted. Missing/corrupt cache → empty array. Sizing is
 * deliberately allowed to be slightly stale: holdings rarely change size, so an
 * approximate order is fine and avoids blocking on a fresh decrypt.
 */
export function readSymbolPlan(storage: StorageLike | null = defaultStorage()): PlannedSymbol[] {
  const raw = readJson<unknown>(storage, SYMBOL_PLAN_KEY);
  if (!Array.isArray(raw)) return [];
  const out: PlannedSymbol[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.symbol !== "string" || e.symbol.length === 0) continue;
    out.push({
      symbol: e.symbol,
      priceType: typeof e.priceType === "string" ? e.priceType : "market",
      assetClass: typeof e.assetClass === "string" ? e.assetClass : "",
      sizeEur: typeof e.sizeEur === "number" && Number.isFinite(e.sizeEur) ? e.sizeEur : 0,
    });
  }
  return out;
}

/** Persist the priority-ordered prefetch plan (best-effort). */
export function writeSymbolPlan(plan: PlannedSymbol[], storage: StorageLike | null = defaultStorage()): void {
  writeJson(storage, SYMBOL_PLAN_KEY, plan);
}

/**
 * A compact snapshot of *what the book looked like when we last left* — written
 * on every successful pull and again on log-out — so the next login can reason,
 * **before the blob is even decrypted**, about how much actually needs fetching.
 *
 * It is the "good saving when logging off" half of smart-routing prefetch: rather
 * than re-discover the world from scratch, the pre-flight reads this to log (and,
 * coarsely, explain) the delta — e.g. "last seen: closed market, NAVs missing →
 * warm only the mutual funds". The graph/quote staleness is still re-checked live
 * against the caches/{@link TimeSeriesStore}; this only records the *prior* state
 * for context. Holds only flags + timestamps — never a price, holding or secret.
 */
export interface SessionStatus {
  /** When this snapshot was written (epoch ms). */
  at: number;
  /** When live data was last genuinely pulled (epoch ms), or null. */
  lastPullAt: number | null;
  /** Coarse market phase at snapshot time (`open` | `closed` | `settled`). */
  marketPhase: string;
  /** Whether every market (stock/ETF) settled close was in hand. */
  marketCovered: boolean;
  /** Whether every NAV fund's latest expected publish was in hand. */
  navCovered: boolean;
  /** The 1D session day whose intraday bars were on the device, or null. */
  sessionGraphDay: string | null;
  /** Whether the 1W daily-bar window was fully covered for the market sleeve. */
  weekGraphCovered: boolean;
}

/** Read the last persisted session-status snapshot, or null when absent/corrupt. */
export function readSessionStatus(storage: StorageLike | null = defaultStorage()): SessionStatus | null {
  const raw = readJson<Partial<SessionStatus>>(storage, SESSION_STATUS_KEY);
  if (!raw || typeof raw !== "object" || typeof raw.at !== "number") return null;
  return {
    at: raw.at,
    lastPullAt: typeof raw.lastPullAt === "number" ? raw.lastPullAt : null,
    marketPhase: typeof raw.marketPhase === "string" ? raw.marketPhase : "settled",
    marketCovered: raw.marketCovered === true,
    navCovered: raw.navCovered === true,
    sessionGraphDay: typeof raw.sessionGraphDay === "string" ? raw.sessionGraphDay : null,
    weekGraphCovered: raw.weekGraphCovered === true,
  };
}

/** Persist the session-status snapshot (best-effort). */
export function writeSessionStatus(
  status: SessionStatus,
  storage: StorageLike | null = defaultStorage(),
): void {
  writeJson(storage, SESSION_STATUS_KEY, status);
}

export const CACHE_KEYS = {
  QUOTE_KEY,
  FX_KEY,
  EURUSD_KEY,
  CREDIT_KEY,
  TIINGO_CREDIT_KEY,
  TIINGO_STATE_KEY,
  BLOB_KEY,
  SYMBOL_PLAN_KEY,
  SESSION_STATUS_KEY,
} as const;

/**
 * Wipe every cached *price* reading — quotes, FX, and the EUR/USD pair — so the
 * next refresh re-fetches all of them from scratch regardless of their cache
 * windows. This is the data side of the Settings "Update all" control: a manual
 * escape hatch for when a stale or wrong cached value would otherwise stick
 * around behind its (deliberately long) NAV/closed-market freshness window.
 *
 * The rolling credit log is intentionally left untouched so a from-scratch pull
 * still respects the free-tier daily budget, and the encrypted blob is left to
 * its own conditional-download path. The symbol plan IS cleared here: a
 * from-scratch reset is exactly when a fund (e.g. one stuck on an old NAV) needs
 * a clean slate, and the plan is rebuilt on the next refresh.
 */
export function clearPriceCaches(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  for (const key of [QUOTE_KEY, FX_KEY, EURUSD_KEY, SYMBOL_PLAN_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      /* best-effort: a storage failure just leaves that cache in place. */
    }
  }
}
