/**
 * Live-graph orchestration — ties the Phase 2–4 curve builders together with the
 * **batched** price and FX backfills (docs/v3.0_live_web_companion_proposal.md
 * §10.8).
 *
 * The 1D ({@link loadOrBuildSessionCurve}) and 1W ({@link loadOrBuildWeekCurve})
 * builders each take an injected `fetchBars`/`fetchDailyBars` (native price bars)
 * and an optional `fetchFx` (EUR→USD bars). This module assembles those
 * injectables from the app's two providers:
 *
 *   - **Prices** — the dual pipe: Tiingo via the unified Worker `/price` route
 *     (`?intraday=` for the 1D curve, `?daily=` for the 1W curve — one request
 *     per ticker, off Tiingo's own budget) with an automatic fall-back to Twelve
 *     Data's browser-direct `time_series` (1 credit/symbol) when Tiingo is
 *     unavailable. Tiingo is preferred because its bulk history fetch is fast and
 *     free of the per-minute Twelve Data cap, so the graph paints promptly even
 *     in a short (2–3 min) session.
 *   - **FX** — the *same batched style*: one Tiingo `/price?fxHistory=eurusd`
 *     request over the curve's exact date window pulls the per-bar EUR→USD track
 *     ({@link makeTiingoFxBarFetcher}), so a back-dated graph re-marks each point
 *     at its **own settled FX rate** (finest available granularity) instead of a
 *     single uniform rescale. The Tiingo FX integration shipped with the backup
 *     live FX provider, so the history endpoint is already proxied.
 *
 * Everything that touches the network (`fetchImpl`, the API key) or persistence
 * (the {@link TimeSeriesStore}) is injected, so the whole orchestration is
 * unit-testable with no DOM, IndexedDB, or live API. When a proxy/key is absent
 * the corresponding pipe simply drops out (prices fall back to Twelve Data; FX
 * falls back to the day's settled `baseFx`), and the graph still draws.
 */

import { fetchTimeSeries, EUR_USD_SYMBOL, PriceError, type FetchLike } from "./prices";
import {
  recordCredits,
  recordTiingoCredits,
  releaseCredits,
  releaseTiingoCredits,
  readSeriesBackoff,
  writeSeriesBackoff,
  clearSeriesBackoff,
  DEFAULT_SERIES_BACKOFF_MS,
  DEFAULT_SERIES_BACKOFF_ATTEMPTS,
  type SeriesBackoffEntry,
  type StorageLike,
} from "./cache";
import {
  lastSessionDate,
  recentTradingSessions,
} from "./market-hours";
import {
  loadOrBuildSessionCurve,
  type BarFetcher,
  type SessionCurve,
  type SessionCurveOptions,
} from "./intraday";
import { makeTiingoBarFetcher, makeDualPipeBarFetcher } from "./intraday-tiingo";
import { makeTiingoFxBarFetcher } from "./tiingo";
import type { Bar } from "./timeseries";
import {
  loadOrBuildWeekCurve,
  wrapDailyNavFetcher,
  DEFAULT_WEEK_SESSIONS,
  type WeekCurve,
  type WeekCurveOptions,
} from "./week";

/** An inclusive `YYYY-MM-DD` date window (New-York calendar). */
export interface DateWindow {
  startDate: string;
  endDate: string;
}

/** The single-session window the live 1D curve (and its FX track) covers. */
export function sessionFxWindow(now: Date = new Date()): DateWindow {
  const day = lastSessionDate(now);
  return { startDate: day, endDate: day };
}

/** The trailing trading-session window the live 1W curve (and FX) covers. */
export function weekFxWindow(
  now: Date = new Date(),
  sessions: number = DEFAULT_WEEK_SESSIONS,
): DateWindow {
  const window = recentTradingSessions(Math.max(1, sessions), now);
  return { startDate: window[0], endDate: window[window.length - 1] };
}

/** A callback that books `n` API credits against a source's budget log. */
export type SpendRecorder = (n: number) => void;

/** Which backfill leg produced a spend — for the data-polling log's leg tag. */
export type SpendLeg = "bars" | "fx" | "quote";

/** A single backfill request the {@link BackfillMeter} accounts for. */
export interface SpendRequest {
  /** The leg tag (`bars`/`fx`/`quote`) for the log line. */
  leg: SpendLeg;
  /**
   * The symbols requested (deduped). For the FX leg this is the pair, e.g.
   * `["eurusd"]`, rendered as `FX eurusd` in the log.
   */
  symbols: string[];
  /** Worst-case credit cost of the request (1 per symbol; 1 for the FX batch). */
  n: number;
}

/**
 * Two-phase credit meter for a live-graph backfill leg
 * (`docs/tiingo_polling_storm_cleanup_plan.md` items 1–3). Every dispatch
 * **reserves** its worst-case cost up-front so concurrent/subsequent calls see
 * the budget already committed and pace themselves; the result is then
 * **settled** (the provider billed it — keep the reservation, log what we
 * pulled) or **refunded** (the provider never metered it — a Worker reject,
 * provider error, or transport throw — so the reservation is released and a
 * labelled failure line is logged instead of leaving a phantom charge).
 */
export interface BackfillMeter {
  /** Debit the worst-case cost before dispatch. */
  reserve(req: SpendRequest): void;
  /** Provider billed the call: keep the reservation; `bars` is the count returned. */
  settle(req: SpendRequest & { bars: number }): void;
  /** Provider did not bill (reject/error/throw): refund and log why. */
  refund(req: SpendRequest & { reason: string }): void;
}

/** The deduped, non-blank symbol set of a request. */
function uniqueSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim()).filter((s) => s.length > 0))];
}

/** Total bars across a fetched symbol→bars map (to spot a billed-but-empty pull). */
function totalBars(bars: Map<string, Bar[]>): number {
  let n = 0;
  for (const list of bars.values()) n += list.length;
  return n;
}

/** A short, log-safe description of why a pull was not billed. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * Wrap a {@link BarFetcher} in the two-phase {@link BackfillMeter}: reserve one
 * credit per requested symbol up-front, then **settle** (keep) the reservation
 * when the provider returns — even an empty `[]`/`404`, which still reached the
 * meter — or **refund** it when the pipe throws (a Worker `400`/`429`/`502`/`503`
 * reject, provider error, or transport abort that the provider never billed). A
 * fallback after a thrown primary therefore records only the fallback's spend.
 */
export function recordingBarFetcher(
  inner: BarFetcher,
  meter: BackfillMeter,
  leg: SpendLeg = "bars",
): BarFetcher {
  return async (symbols) => {
    const uniq = uniqueSymbols(symbols);
    const n = uniq.length;
    if (n === 0) return new Map<string, Bar[]>();
    meter.reserve({ leg, symbols: uniq, n });
    try {
      const bars = await inner(uniq);
      meter.settle({ leg, symbols: uniq, n, bars: totalBars(bars) });
      return bars;
    } catch (err) {
      meter.refund({ leg, symbols: uniq, n, reason: describeError(err) });
      throw err;
    }
  };
}

/**
 * Wrap an FX-history fetcher (a single batched request) in the two-phase meter:
 * reserve one Tiingo credit, **settle** it when the pull returns (the meter was
 * reached — even an empty window), or **refund** it when the pipe throws. This is
 * the precise fix for the polling-storm phantom charge: a dead `fxHistory` route
 * returns a Worker `400` (now a throw) → the reservation is refunded, not booked.
 */
export function recordingFxFetcher(
  inner: () => Promise<Bar[]>,
  meter: BackfillMeter,
): () => Promise<Bar[]> {
  const req: SpendRequest = { leg: "fx", symbols: ["eurusd"], n: 1 };
  return async () => {
    meter.reserve(req);
    try {
      const bars = await inner();
      meter.settle({ ...req, bars: bars.length });
      return bars;
    } catch (err) {
      meter.refund({ ...req, reason: describeError(err) });
      throw err;
    }
  };
}

/**
 * The simplest {@link BackfillMeter}: book the reservation against `record` and
 * release a not-billed reservation back via `refund`, with no logging. Used as
 * the default wiring when a caller does not supply an instrumented meter.
 */
export function ledgerMeter(record: SpendRecorder, refund: SpendRecorder): BackfillMeter {
  return {
    reserve: (req) => record(req.n),
    settle: () => undefined,
    refund: (req) => refund(req.n),
  };
}

/**
 * Build the Twelve Data **Pipe A** price {@link BarFetcher} (browser-direct
 * `time_series`, 1 credit/symbol). Returns `null` when no API key is held, so the
 * caller can decide whether a Tiingo-only pipe is still usable.
 */
export function makeTwelveDataBarFetcher(
  apiKey: string,
  options: { interval?: string; outputsize?: number; fetchImpl?: FetchLike } = {},
): BarFetcher | null {
  const key = apiKey.trim();
  if (!key) return null;
  return (symbols) => fetchTimeSeries(symbols, key, options);
}

/**
 * Compose the dual-pipe price backfill: prefer Tiingo (Pipe B, via the unified
 * `/price` Worker proxy) and fall back to Twelve Data (Pipe A) the moment Pipe B
 * is unavailable. The `param` selects the Tiingo feed (`intraday` for the 1D
 * curve, `daily` for the 1W curve). When only one pipe is configured that pipe is
 * used alone; when neither is, `null` is returned (the curve then has no price
 * bars and the builder yields an empty curve).
 */
export function makePriceBarFetcher(opts: {
  apiKey: string;
  proxyUrl: string | null;
  param?: "intraday" | "daily";
  interval?: string;
  outputsize?: number;
  startDate?: string;
  endDate?: string;
  fetchImpl?: FetchLike;
  /** Meter the Tiingo (Pipe B) bar spend in two phases. */
  tiingoMeter?: BackfillMeter;
  /** Meter the Twelve Data (Pipe A) bar spend in two phases. */
  twelveDataMeter?: BackfillMeter;
  /**
   * Live remaining Twelve Data per-minute/day budget. When supplied (and both
   * pipes exist), the fetch becomes the capacity-aware split (item 8): Twelve
   * Data first up to this budget, Tiingo for the overflow. Omit for the legacy
   * Tiingo-first dual pipe.
   */
  budget?: () => { minute: number; day: number };
  /**
   * Per-symbol time-series backoff (item 4). When supplied, symbols whose
   * `${scope}:${symbol}` key is in an armed cooldown are skipped (no credit, no
   * attempt) and fall back to their flat quote value on the curve.
   */
  backoff?: { memo: SeriesBackoff; scope: string; now?: () => number };
}): BarFetcher | null {
  const {
    apiKey,
    proxyUrl,
    param,
    interval,
    outputsize,
    startDate,
    endDate,
    fetchImpl,
    tiingoMeter,
    twelveDataMeter,
    budget,
    backoff,
  } = opts;
  let pipeA = makeTwelveDataBarFetcher(apiKey, { interval, outputsize, fetchImpl });
  let pipeB = proxyUrl
    ? makeTiingoBarFetcher(proxyUrl, { param, startDate, endDate, fetchImpl })
    : null;
  // Meter each pipe against its own source budget, so whichever one actually
  // serves the bars is the one that books the credits (a fallback after a thrown
  // primary records only the fallback's spend).
  if (pipeA && twelveDataMeter) pipeA = recordingBarFetcher(pipeA, twelveDataMeter);
  if (pipeB && tiingoMeter) pipeB = recordingBarFetcher(pipeB, tiingoMeter);
  let combined: BarFetcher | null;
  if (pipeB && pipeA) {
    // With a live budget, fill Twelve Data first and spill the overflow to Tiingo
    // (item 8); otherwise keep the legacy Tiingo-first failover dual pipe.
    combined = budget
      ? makeCapacitySplitBarFetcher(pipeA, pipeB, budget)
      : makeDualPipeBarFetcher(pipeB, pipeA);
  } else {
    combined = pipeB ?? pipeA;
  }
  // The per-symbol backoff sits outermost, scoring the post-fallback result, so a
  // symbol is only parked once *both* providers have failed to serve it.
  if (combined && backoff) {
    return withBarBackoff(combined, backoff.memo, (s) => `${backoff.scope}:${s}`, {
      now: backoff.now,
    });
  }
  return combined;
}

/** Merge two symbol→bars maps; non-empty bars from `extra` win over `base` gaps. */
function mergeBarMaps(base: Map<string, Bar[]>, extra: Map<string, Bar[]>): Map<string, Bar[]> {
  const out = new Map(base);
  for (const [symbol, bars] of extra) {
    if (bars.length > 0) out.set(symbol, bars);
  }
  return out;
}

/** Fetch one provider leg, reporting which requested symbols came back empty/failed. */
async function fetchBarLeg(
  fetcher: BarFetcher,
  symbols: string[],
): Promise<{ bars: Map<string, Bar[]>; missing: string[] }> {
  if (symbols.length === 0) return { bars: new Map<string, Bar[]>(), missing: [] };
  try {
    const bars = await fetcher(symbols);
    const missing = symbols.filter((s) => !(bars.get(s)?.length));
    return { bars, missing };
  } catch (err) {
    // A whole-batch reject (a Worker/provider error) spills every assigned symbol.
    if (err instanceof PriceError) return { bars: new Map<string, Bar[]>(), missing: symbols };
    throw err;
  }
}

/**
 * Capacity-aware provider split for graph bars (price **and** NAV series), item
 * 8 — the reverse of the old Tiingo-first dual pipe. Fill **Twelve Data (Pipe A)**
 * up to the live remaining per-minute/day budget, route the overflow to **Tiingo
 * (Pipe B)**, and run both legs concurrently so the paint stays instant. A symbol
 * that *fails or comes back empty* on Twelve Data still spills to Tiingo
 * underneath the split. Rationale: Twelve Data's 8/min replenishes every minute
 * (the plentiful pool) while Tiingo's 40/hour is scarce — so fill the plentiful
 * one first and spend the scarce one only on the overflow.
 *
 * `budget()` must read the **live** shared credit log so the graph only takes
 * what the (earlier, prefetch-led) quote pass left — see
 * {@link ../quotes.twelveDataBudgetRemaining}.
 */
export function makeCapacitySplitBarFetcher(
  twelveData: BarFetcher,
  tiingo: BarFetcher,
  budget: () => { minute: number; day: number },
): BarFetcher {
  return async (symbols) => {
    const uniq = uniqueSymbols(symbols);
    if (uniq.length === 0) return new Map<string, Bar[]>();
    const { minute, day } = budget();
    const capacity = Math.max(0, Math.min(uniq.length, minute, day));
    const toTwelveData = uniq.slice(0, capacity);
    const toTiingo = uniq.slice(capacity);
    const [a, b] = await Promise.all([
      fetchBarLeg(twelveData, toTwelveData),
      fetchBarLeg(tiingo, toTiingo),
    ]);
    let result = mergeBarMaps(a.bars, b.bars);
    // Spill any Twelve Data misses (failed/empty) to Tiingo, unless the overflow
    // leg already covered them.
    const spill = a.missing.filter((s) => !(result.get(s)?.length));
    if (spill.length > 0) {
      const spilled = await fetchBarLeg(tiingo, spill);
      result = mergeBarMaps(result, spilled.bars);
    }
    return result;
  };
}

/** Map a Tiingo FX `resampleFreq` to the nearest Twelve Data `time_series` interval. */
function twelveDataFxInterval(resampleFreq: string): string {
  const map: Record<string, string> = {
    "1min": "1min",
    "5min": "5min",
    "15min": "15min",
    "30min": "30min",
    "1hour": "1h",
    "2hour": "2h",
    "4hour": "4h",
    "1day": "1day",
    "1week": "1week",
  };
  return map[resampleFreq] ?? "1h";
}

/**
 * Build the Twelve Data **forex** FX-history fetcher: the `EUR/USD`
 * `time_series` (1 credit, browser-direct) re-shaped as the curve's EUR→USD bar
 * track. This is the FX analogue of Pipe A — the fallback the Tiingo FX leg
 * degrades to when the Worker FX route is empty or unavailable
 * (`docs/tiingo_polling_storm_cleanup_plan.md` item 4). Returns `null` with no key.
 */
export function makeTwelveDataFxFetcher(
  apiKey: string,
  options: { interval?: string; outputsize?: number; fetchImpl?: FetchLike } = {},
): (() => Promise<Bar[]>) | null {
  const key = apiKey.trim();
  if (!key) return null;
  return async () => {
    const map = await fetchTimeSeries([EUR_USD_SYMBOL], key, options);
    return map.get(EUR_USD_SYMBOL) ?? [];
  };
}

/**
 * Compose two FX fetchers into a dual pipe mirroring {@link makeDualPipeBarFetcher}:
 * try `primary` (Tiingo FX), and fall back to `fallback` (Twelve Data forex) when
 * the primary **throws** (a Worker reject) *or* returns **no bars** (an empty
 * window that would otherwise pin every point to the flat `baseFx`).
 */
export function makeDualFxFetcher(
  primary: () => Promise<Bar[]>,
  fallback: () => Promise<Bar[]>,
): () => Promise<Bar[]> {
  return async () => {
    try {
      const bars = await primary();
      if (bars.length > 0) return bars;
      return await fallback();
    } catch (err) {
      if (err instanceof PriceError) return fallback();
      throw err;
    }
  };
}

/**
 * A persisted, timestamp-based **time-series backoff** shared by the price-bar
 * and FX-history fetchers (`docs/tiingo_polling_storm_cleanup_plan.md` item 4).
 * It tracks, per `key` (a price symbol or an FX leg), how many consecutive
 * attempts have failed and — once that count crosses the threshold — when the
 * cooldown armed, so a *genuinely dead* series stops being re-pulled on every
 * graph switch while a transient miss is still retried. Quotes are never gated
 * by this; only time-series pulls are.
 */
export interface SeriesBackoff {
  /** True when `key` is in an armed cooldown at `now` (skip the network). */
  suppressed(key: string, now: number): boolean;
  /** Record a failed/empty attempt; arms the cooldown at the Nth strike. */
  fail(key: string, now: number): void;
  /** Forget `key` after a successful, non-empty pull. */
  succeed(key: string): void;
}

/**
 * The shared {@link SeriesBackoff}: an attempt is allowed until it has failed
 * `attempts` times in a row, after which the series is suppressed for
 * `cooldownMs` (wall-clock, persisted). Once that window elapses the strike
 * count resets, so the next rebuild gets a fresh set of attempts.
 */
export function cacheSeriesBackoff(
  options: {
    attempts?: number;
    cooldownMs?: number;
    storage?: StorageLike | null;
  } = {},
): SeriesBackoff {
  const attempts = options.attempts ?? DEFAULT_SERIES_BACKOFF_ATTEMPTS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_SERIES_BACKOFF_MS;
  const storage = options.storage;
  const read = (key: string): SeriesBackoffEntry | null =>
    storage === undefined ? readSeriesBackoff(key) : readSeriesBackoff(key, storage);
  const write = (key: string, entry: SeriesBackoffEntry): void =>
    storage === undefined ? writeSeriesBackoff(key, entry) : writeSeriesBackoff(key, entry, storage);
  const clear = (key: string): void =>
    storage === undefined ? clearSeriesBackoff(key) : clearSeriesBackoff(key, storage);
  return {
    suppressed: (key, now) => {
      const e = read(key);
      return e !== null && e.armedAt !== null && now - e.armedAt < cooldownMs;
    },
    fail: (key, now) => {
      let e = read(key) ?? { fails: 0, armedAt: null };
      // A fully-elapsed cooldown is a fresh window: reset the strike count so the
      // series earns another `attempts` tries before re-arming.
      if (e.armedAt !== null && now - e.armedAt >= cooldownMs) e = { fails: 0, armedAt: null };
      const fails = e.fails + 1;
      const armedAt = fails >= attempts ? now : e.armedAt;
      write(key, { fails, armedAt });
    },
    succeed: (key) => clear(key),
  };
}

/**
 * Wrap the single-batch FX fetcher with the {@link SeriesBackoff}: skip the
 * network (return `[]`, no credit) while `key` is in an armed cooldown, count an
 * empty window or a thrown reject as a failure, and clear the memo on a non-empty
 * pull. FX is just another time series, so it shares the bars' 3-strike model.
 */
export function withFxBackoff(
  inner: () => Promise<Bar[]>,
  backoff: SeriesBackoff,
  key: string,
  options: { now?: () => number } = {},
): () => Promise<Bar[]> {
  const now = options.now ?? ((): number => Date.now());
  return async () => {
    const t = now();
    if (backoff.suppressed(key, t)) return []; // suppressed: no fetch, no charge
    try {
      const bars = await inner();
      if (bars.length > 0) backoff.succeed(key);
      else backoff.fail(key, t);
      return bars;
    } catch (err) {
      // A reject is a strike too (so rebuilds don't hammer it) but still
      // propagates once so the recorder boundary logs the failure.
      backoff.fail(key, t);
      throw err;
    }
  };
}

/**
 * Wrap a multi-symbol {@link BarFetcher} with a **per-symbol** time-series
 * backoff. Symbols whose `keyFor(symbol)` is in an armed cooldown are dropped
 * before the network call (no credit, no attempt) and are simply absent from the
 * result — so the curve reconstruction holds them flat at their latest **quote**
 * value (`ratioAt` → 1 for a symbol with no bars), the quote fallback. Every
 * fetched symbol is scored: non-empty bars clear its memo, an empty/missing
 * symbol takes a strike, and a whole-batch reject strikes every attempted symbol.
 * Quotes are untouched — only the graph's time-series pulls back off.
 */
export function withBarBackoff(
  inner: BarFetcher,
  backoff: SeriesBackoff,
  keyFor: (symbol: string) => string,
  options: { now?: () => number } = {},
): BarFetcher {
  const now = options.now ?? ((): number => Date.now());
  return async (symbols) => {
    const t = now();
    const uniq = uniqueSymbols(symbols);
    const allowed = uniq.filter((s) => !backoff.suppressed(keyFor(s), t));
    if (allowed.length === 0) return new Map<string, Bar[]>();
    try {
      const bars = await inner(allowed);
      for (const s of allowed) {
        if (bars.get(s)?.length) backoff.succeed(keyFor(s));
        else backoff.fail(keyFor(s), t);
      }
      return bars;
    } catch (err) {
      for (const s of allowed) backoff.fail(keyFor(s), t);
      throw err;
    }
  };
}

/** Tunables for the FX fallback/backoff added to {@link makeWindowFxFetcher}. */
export interface WindowFxOptions {
  /** Twelve Data key for the forex fallback (`EUR/USD` time_series). Empty ⇒ Tiingo-only. */
  apiKey?: string;
  /** Meter the Twelve Data forex spend (Pipe A) in two phases. */
  twelveDataMeter?: BackfillMeter;
  /** Shared time-series backoff; omit to disable the cooldown. */
  backoff?: SeriesBackoff | null;
  /** Backoff key for this FX leg (e.g. `"fx:1W:1day"`). Required with `backoff`. */
  backoffKey?: string;
  /** Override `Date.now` for the backoff (tests). */
  now?: () => number;
}

/**
 * Bind the batched FX-history fetcher to a window + cadence. Prefers the Tiingo
 * `/price?fxHistory=` route (Pipe B) and — when a Twelve Data key is supplied —
 * **falls back to the Twelve Data forex `EUR/USD` series** the moment Tiingo FX
 * is empty or unavailable, mirroring the price dual pipe. A negative-result
 * backoff suppresses re-attempts after an empty/failed window. Returns `null`
 * only when *neither* an FX pipe is configured (no proxy and no key) — the curve
 * then falls back to the day's settled `baseFx` for every point.
 */
export function makeWindowFxFetcher(
  priceProxyUrl: string | null,
  window: DateWindow,
  resampleFreq: string,
  fetchImpl?: FetchLike,
  tiingoMeter?: BackfillMeter,
  options: WindowFxOptions = {},
): (() => Promise<Bar[]>) | null {
  const tiingoFxRaw = priceProxyUrl
    ? makeTiingoFxBarFetcher(priceProxyUrl, {
        resampleFreq,
        startDate: window.startDate,
        endDate: window.endDate,
        fetchImpl,
      })
    : null;
  const tiingoFx = tiingoFxRaw
    ? tiingoMeter
      ? recordingFxFetcher(tiingoFxRaw, tiingoMeter)
      : tiingoFxRaw
    : null;

  const twelveRaw = makeTwelveDataFxFetcher(options.apiKey ?? "", {
    interval: twelveDataFxInterval(resampleFreq),
    outputsize: 60,
    fetchImpl,
  });
  const twelveFx = twelveRaw
    ? options.twelveDataMeter
      ? recordingFxFetcher(twelveRaw, options.twelveDataMeter)
      : twelveRaw
    : null;

  let composite: (() => Promise<Bar[]>) | null;
  if (tiingoFx && twelveFx) composite = makeDualFxFetcher(tiingoFx, twelveFx);
  else composite = tiingoFx ?? twelveFx;
  if (!composite) return null;

  if (options.backoff && options.backoffKey) {
    composite = withFxBackoff(composite, options.backoff, options.backoffKey, {
      now: options.now,
    });
  }
  return composite;
}

/** Shared network/persistence wiring for the live-graph builders. */
export interface LiveGraphProviders {
  /** Twelve Data API key (Pipe A). Empty ⇒ Tiingo-only prices. */
  apiKey: string;
  /** Unified Worker `/price` route (Tiingo prices + FX history). Null ⇒ Twelve Data only. */
  priceProxyUrl: string | null;
  /** Injected fetch (defaults to the global). */
  fetchImpl?: FetchLike;
  /**
   * Meter the Tiingo spend (price bars via Pipe B, plus the FX-history pull).
   * Defaults to the persisted Tiingo credit log (reserve + refund, no logging).
   */
  tiingoMeter?: BackfillMeter;
  /**
   * Meter the Twelve Data spend (price bars via Pipe A). Defaults to the
   * persisted Twelve Data credit log (reserve + refund, no logging).
   */
  twelveDataMeter?: BackfillMeter;
  /**
   * Live remaining Twelve Data per-minute/day budget. When supplied, the bar
   * fetch becomes the capacity-aware split (item 8): Twelve Data first up to this
   * budget, Tiingo for the overflow. Omit to keep the legacy Tiingo-first pipe.
   */
  budget?: () => { minute: number; day: number };
  /**
   * Shared per-symbol time-series backoff (item 4). Defaults to the persisted
   * {@link cacheSeriesBackoff}. Symbols that keep failing are parked off the
   * network and fall back to their flat quote value; quotes are never gated.
   */
  backoff?: SeriesBackoff;
}

/** Resolve the Tiingo/Twelve Data meters, defaulting to the real ledgers. */
function spendMeters(providers: LiveGraphProviders): {
  tiingoMeter: BackfillMeter;
  twelveDataMeter: BackfillMeter;
} {
  return {
    tiingoMeter:
      providers.tiingoMeter ??
      ledgerMeter(
        (n) => recordTiingoCredits(n, Date.now()),
        (n) => releaseTiingoCredits(n, Date.now()),
      ),
    twelveDataMeter:
      providers.twelveDataMeter ??
      ledgerMeter(
        (n) => recordCredits(n, Date.now()),
        (n) => releaseCredits(n, Date.now()),
      ),
  };
}

/** Options for {@link instrumentedGraphRecorders}. */
export interface GraphRecorderOptions {
  /** Range label for the log line, e.g. `"1D"` or `"1W"`. */
  range: string;
  /** Reserve a Twelve Data (Pipe A) spend against its budget log. */
  bookTwelveData: SpendRecorder;
  /** Refund a not-billed Twelve Data reservation. */
  refundTwelveData: SpendRecorder;
  /** Reserve a Tiingo (Pipe B / FX) spend against its budget log. */
  bookTiingo: SpendRecorder;
  /** Refund a not-billed Tiingo reservation. */
  refundTiingo: SpendRecorder;
  /** Sink for a plain-language log line (e.g. the Settings polling log). */
  log: (message: string) => void;
  /** Shared counter: total credits this build actually pulled (0 ⇒ all reused). */
  spent: { credits: number };
}

/** Render a request's subject for the log: the symbol list, or `FX <pair>`. */
function spendSubject(req: SpendRequest): string {
  if (req.leg === "fx") return `FX ${req.symbols.join(",")}`;
  return req.symbols.join(", ");
}

/**
 * Wrap the two graph spend ledgers as instrumented {@link BackfillMeter}s so
 * every live 1D/1W backfill pull is, in one step: (1) reserved against its
 * provider's budget log up-front, (2) on a billed result, tallied into a shared
 * `spent` counter (so the caller can tell a real pull from a fully-reused render)
 * and reported in plain language to `log` — naming the **leg** (`bars`/`fx`) and
 * the **symbols** (or `FX eurusd`) so the data-polling log shows exactly what
 * each graph pulled — and (3) on a not-billed result, refunded *and* logged as a
 * labelled failure, so a Worker reject/empty never leaves a phantom charge or a
 * silent gap. A bar fetch bills one credit per symbol; an FX-history pull bills
 * one Tiingo credit for the whole window.
 */
export function instrumentedGraphRecorders(
  opts: GraphRecorderOptions,
): { twelveDataMeter: BackfillMeter; tiingoMeter: BackfillMeter } {
  const { range, bookTwelveData, refundTwelveData, bookTiingo, refundTiingo, log, spent } = opts;
  const plural = (n: number): string => (n === 1 ? "" : "s");
  const meter = (
    provider: string,
    creditNoun: string,
    book: SpendRecorder,
    refund: SpendRecorder,
  ): BackfillMeter => ({
    reserve: (req) => book(req.n),
    settle: (req) => {
      spent.credits += req.n;
      const empty = req.bars === 0 ? " (empty — reached the provider, no bars)" : "";
      log(
        `${range} graph: fetched ${req.leg} ${spendSubject(req)} via ${provider} — ` +
          `${req.n} ${creditNoun}${plural(req.n)}${empty}.`,
      );
    },
    refund: (req) => {
      refund(req.n);
      log(
        `${range} graph: ${req.leg} ${spendSubject(req)} via ${provider} not billed ` +
          `(${req.n} ${creditNoun}${plural(req.n)} refunded) — ${req.reason}.`,
      );
    },
  });
  return {
    twelveDataMeter: meter("Twelve Data (Pipe A)", "credit", bookTwelveData, refundTwelveData),
    tiingoMeter: meter("Tiingo (Pipe B)", "Tiingo credit", bookTiingo, refundTiingo),
  };
}

/** Per-bar cadence the 1D price feed (and matching FX track) requests. */
export interface SessionGraphTuning {
  /** Twelve Data `time_series` interval for Pipe A (default `5min`). */
  interval?: string;
  /** Twelve Data `outputsize` for Pipe A (default 78 ≈ a 5-min session). */
  outputsize?: number;
  /** Tiingo FX-history resample for the day's FX track (default `1hour`). */
  fxResampleFreq?: string;
}

/**
 * Build the live **1 Day** curve with both backfills wired in: the dual-pipe
 * price fetcher and the batched Tiingo FX-history fetcher over the session day.
 * `anchor`, `store`, `now`, `liveTip` and `retainSessions` are passed straight
 * through to {@link loadOrBuildSessionCurve}.
 */
export function buildLiveSessionCurve(
  base: Omit<SessionCurveOptions, "fetchBars" | "fetchFx">,
  providers: LiveGraphProviders,
  tuning: SessionGraphTuning = {},
): Promise<SessionCurve> {
  const now = base.now ?? new Date();
  const window = sessionFxWindow(now);
  const { tiingoMeter, twelveDataMeter } = spendMeters(providers);
  const backoff = providers.backoff ?? cacheSeriesBackoff();
  const fetchBars =
    makePriceBarFetcher({
      apiKey: providers.apiKey,
      proxyUrl: providers.priceProxyUrl,
      param: "intraday",
      interval: tuning.interval,
      outputsize: tuning.outputsize,
      startDate: window.startDate,
      endDate: window.endDate,
      fetchImpl: providers.fetchImpl,
      tiingoMeter,
      twelveDataMeter,
      budget: providers.budget,
      backoff: { memo: backoff, scope: "1D" },
    }) ?? emptyBarFetcher;
  const fetchFx = makeWindowFxFetcher(
    providers.priceProxyUrl,
    window,
    tuning.fxResampleFreq ?? "1hour",
    providers.fetchImpl,
    tiingoMeter,
    {
      apiKey: providers.apiKey,
      twelveDataMeter,
      backoff,
      backoffKey: `fx:1D:${tuning.fxResampleFreq ?? "1hour"}`,
    },
  );
  return loadOrBuildSessionCurve({ ...base, fetchBars, fetchFx });
}

/**
 * Build the live **1 Week** curve with both backfills wired in: a dual-pipe
 * daily-close price fetcher (Tiingo `?daily=` first, Twelve Data `interval=1day`
 * fallback) and the batched Tiingo FX-history fetcher (daily cadence) over the
 * trailing-session window. `anchor`, `store`, `now`, `liveTip`, `sessions` and
 * `storeKey` pass straight through to {@link loadOrBuildWeekCurve}.
 */
export function buildLiveWeekCurve(
  base: Omit<WeekCurveOptions, "fetchDailyBars" | "fetchFx">,
  providers: LiveGraphProviders,
): Promise<WeekCurve> {
  const now = base.now ?? new Date();
  const sessions = base.sessions ?? DEFAULT_WEEK_SESSIONS;
  const window = weekFxWindow(now, sessions);
  const { tiingoMeter, twelveDataMeter } = spendMeters(providers);
  const backoff = providers.backoff ?? cacheSeriesBackoff();
  // The 1W curve is built from one daily close per session. Tiingo's `/price`
  // route serves those via `?daily=<ticker>` (a single batched window per
  // symbol, off Tiingo's own budget), so it is preferred for a prompt paint; the
  // browser-direct Twelve Data `interval=1day` Pipe A is the fallback. The FX
  // track is pulled in the same batched style from Tiingo's FX-history route at a
  // daily cadence.
  const fetchDailyBars =
    makePriceBarFetcher({
      apiKey: providers.apiKey,
      proxyUrl: providers.priceProxyUrl,
      param: "daily",
      interval: "1day",
      outputsize: Math.max(sessions + 2, 8),
      startDate: window.startDate,
      endDate: window.endDate,
      fetchImpl: providers.fetchImpl,
      tiingoMeter,
      twelveDataMeter,
      budget: providers.budget,
      backoff: { memo: backoff, scope: "1W" },
    }) ?? emptyBarFetcher;
  const fetchFx = makeWindowFxFetcher(
    providers.priceProxyUrl,
    window,
    "1day",
    providers.fetchImpl,
    tiingoMeter,
    {
      apiKey: providers.apiKey,
      twelveDataMeter,
      backoff,
      backoffKey: "fx:1W:1day",
    },
  );
  // Item 7b: gap-fill moving-fund NAV history through the *same* capacity-split
  // daily fetcher (Twelve Data up to budget, Tiingo overflow), re-stamped onto
  // the NAV day-start cadence so it aligns with the free-accumulated NAV bars.
  const fetchNavBars = wrapDailyNavFetcher(fetchDailyBars);
  return loadOrBuildWeekCurve({ ...base, fetchDailyBars, fetchFx, fetchNavBars });
}

/** A no-op {@link BarFetcher} used when neither price pipe is configured. */
const emptyBarFetcher: BarFetcher = async () => new Map<string, Bar[]>();
