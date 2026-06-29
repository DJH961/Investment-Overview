/**
 * Long-range **whole-book value history reconstruction** — the load path that
 * makes the 1M/3M/6M/1Y value graph reloadable *from scratch* (long-range plan,
 * item 1).
 *
 * The {@link ../value-history value-history} store bridges the gap a stale export
 * blob leaves behind by recording each day's whole-book close as the app is used.
 * But that path depends on the app having *been opened* day after day: on an
 * empty device, after a cache wipe, or when the blob is weeks stale and the user
 * opens the companion only occasionally, the store has no point for the
 * in-between days and the long-range chart draws a single straight diagonal
 * across the gap.
 *
 * This module closes that hole the same way the desktop builds its curve: it
 * **fetches multi-month daily-close bars** for every *market* holding (and the
 * matching daily EUR/USD FX), then rebuilds the whole-book daily closes with the
 * existing pure reconstruction maths ({@link reconstructSessionCurve}) —
 * `base + Σ valueᵢ · dailyCloseᵢ(day)/closeᵢ`, each USD-booked holding re-marked
 * at *that day's* settled FX. The result is harvested into the value-history
 * store ({@link harvestDailyCloses}), exactly like the 1W harvest, so the chart
 * draws genuine per-day points instead of an interpolation.
 *
 * ### Why the blob still comes first (empty-device + blob-basis contract)
 * On an empty device **only the blob says which holdings exist** — and, just as
 * importantly, only the blob carries *reinvestments and share/holding changes*
 * over time. So the blob is the **mandatory basis**, never optional: the anchor
 * passed in here is built from the decrypted blob's holdings, and the window
 * always starts the day **after** the blob's last exported curve point
 * ({@link longRangeWindow}). The blob's own `analytics.curve` remains the
 * authoritative history for everything up to its last export — the chart splices
 * it in unchanged (`spliceDailyBackfill`) — and this reconstruction is therefore
 * strictly a **gap-filler** layered on top of it. It never invents holdings, and
 * it never re-derives (and so can never overwrite) any day the blob already
 * covers; generating the whole curve from scratch independent of the blob is not
 * an option, because that would miss the reinvestment/share history only the blob
 * knows.
 *
 * ### Cost discipline
 * Daily bars bill **1 credit per symbol regardless of the date range** (Tiingo
 * `/price` daily / Twelve Data `time_series`), so a year of history costs the
 * same as a week — one credit per market symbol plus one for FX. The fetchers are
 * injected by the caller already wrapped in the shared reservation authority and
 * the per-series backoff (no new bypass), and the build only fetches when the
 * store is genuinely missing days in the window ({@link longRangeGapDays}); when
 * the store already covers the range it is a pure no-op. The window itself is
 * range-limited to what the chart shows (≤ {@link LONG_RANGE_MAX_LOOKBACK_DAYS})
 * and starts after the blob's last export, so the reconstruction only ever fills
 * the gap the blob and the 1W harvest do not already cover.
 *
 * Everything here is side-effect-free except the final harvest, and the network
 * (`fetchDailyBars`/`fetchFx`) and persistence (`store`) are injected, so the
 * whole path is unit-testable with no DOM, IndexedDB, or live API.
 */

import { intradaySymbols, marketSleeveSymbols, type BarFetcher, type IntradayAnchor } from "./intraday";
import { exchangeDayOf, isUsTradingDay, previousTradingSession } from "./market-hours";
import { reconstructSessionCurve, type Bar, type CurvePoint, type ReconHolding } from "./timeseries";
import type { Decimal } from "./decimal-config";
import { harvestDailyCloses, loadValueHistory, type DailyClose } from "./value-history";
import type { TimeSeriesStore } from "./timeseries-store";

/**
 * The furthest back the long-range reconstruction reaches: one year of calendar
 * days. The long-range chart shows at most 1Y, so reaching further would fetch
 * (and store) days the chart never draws. A heavily-stale blob that exported more
 * than a year ago is therefore capped here — the worst case the chart cares about.
 */
export const LONG_RANGE_MAX_LOOKBACK_DAYS = 365;

/** A `YYYY-MM-DD` date shifted by `n` whole UTC days (n may be negative). */
function isoPlusDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whether a `YYYY-MM-DD` (New-York calendar) is a regular NYSE trading day. */
function isTradingDay(day: string): boolean {
  return isUsTradingDay(new Date(`${day}T12:00:00Z`));
}

/** The latest trading session on or before `day` (`day` itself when it trades). */
function sessionOnOrBefore(day: string): string {
  return isTradingDay(day) ? day : previousTradingSession(day);
}

/** An inclusive `YYYY-MM-DD` date window (New-York calendar). */
export interface LongRangeWindow {
  /** First calendar day of the gap to reconstruct (inclusive). */
  startDate: string;
  /** Last calendar day of the gap to reconstruct (inclusive — today). */
  endDate: string;
}

/** Inputs to {@link longRangeWindow}. */
export interface LongRangeWindowInput {
  /** Today's New-York calendar date (`exchangeDate(now)`). */
  today: string;
  /**
   * The blob's last exported `analytics.curve` day (`YYYY-MM-DD`), or `null` when
   * no blob curve is on hand. The blob authoritatively covers history up to this
   * day, so the reconstruction starts the day **after** it; with no blob it
   * reaches the full lookback (the empty-device worst case).
   */
  lastExportDay: string | null;
  /** Override the maximum look-back; defaults to {@link LONG_RANGE_MAX_LOOKBACK_DAYS}. */
  maxLookbackDays?: number;
}

/**
 * The date window the long-range reconstruction should cover: from the day after
 * the blob's last export (or the full look-back when there is no blob), capped to
 * `maxLookbackDays` before today, through today. Returns `null` when there is
 * nothing before today to reconstruct (a fresh blob already covers everything).
 */
export function longRangeWindow(input: LongRangeWindowInput): LongRangeWindow | null {
  const maxLookback = input.maxLookbackDays ?? LONG_RANGE_MAX_LOOKBACK_DAYS;
  const earliest = isoPlusDays(input.today, -Math.max(0, maxLookback));
  const afterExport = input.lastExportDay !== null ? isoPlusDays(input.lastExportDay, 1) : earliest;
  // Never reach before the chart's own horizon (cap), and never before the blob
  // already covers (start after its last export).
  const startDate = afterExport > earliest ? afterExport : earliest;
  if (startDate > input.today) return null;
  return { startDate, endDate: input.today };
}

/**
 * The number of **calendar** days the window spans (inclusive) — used to size a
 * Twelve Data `outputsize` so a worst-case (year-long) gap is delivered in one
 * request per symbol. Daily bars bill the same one credit per symbol whatever the
 * range, so over-asking costs nothing; under-asking would silently truncate the
 * history (the failure mode the new-requirement "reach back long enough" guards).
 */
export function longRangeWindowCalendarDays(window: LongRangeWindow): number {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * The NYSE trading days within an inclusive `[startDate, endDate]` window,
 * ascending (`YYYY-MM-DD`). Walks back from the latest session on or before
 * `endDate` to the first session on or after `startDate`.
 */
export function tradingDaysInWindow(window: LongRangeWindow): string[] {
  const days: string[] = [];
  let day = sessionOnOrBefore(window.endDate);
  while (day >= window.startDate) {
    days.push(day);
    day = previousTradingSession(day);
  }
  return days.reverse();
}

/**
 * Which `days` the stored value history does **not** already carry a close for —
 * the gap the reconstruction would fill. An empty result means the store already
 * covers the window, so the build can skip the network entirely (cost discipline).
 */
export function longRangeGapDays(history: DailyClose[], days: string[]): string[] {
  const have = new Set(history.map((c) => c.date));
  return days.filter((d) => !have.has(d));
}

/** Map the anchor's holdings into the reconstruction's holding shape. */
function toReconHoldings(holdings: IntradayAnchor["holdings"]): ReconHolding[] {
  return holdings.map((h) => ({
    symbol: h.priceSymbol,
    valueEur: h.valueEur,
    valueUsd: h.valueUsd,
    closeNative: h.closeNative,
    isUsdNative: h.isUsdNative,
  }));
}

/** The `YYYY-MM-DD` (New-York calendar) a stamped instant falls on — mirrors the
 * value-history harvest's own bucketing so the window clamp lines up with how a
 * point is later stored. */
function localDayOfInstant(t: number): string {
  return exchangeDayOf(t);
}

/** Inputs to {@link reconstructLongRangeCloses}. */
export interface ReconstructLongRangeInput {
  /** The whole-book anchor (market sleeve + constant cash/NAV base). */
  anchor: IntradayAnchor;
  /** Per-symbol **daily-close** bars across the window. */
  barsBySymbol: Map<string, Bar[]>;
  /** EUR→USD daily bars across the window; empty ⇒ every day falls back to `baseFx`. */
  fxBars?: Bar[];
  /** Per-day whole-book money-market value (USD) so the base steps per day. */
  mmDaysUsd?: { date: string; valueNativeUsd: Decimal }[];
}

/**
 * Rebuild the whole-book curve over a multi-month window of **daily-close** bars
 * — the long-range analogue of the 1W build. Each holding's settled value is
 * re-marked to each day's daily close (`dailyCloseᵢ(day)/closeᵢ`), each
 * USD-booked holding rebased at that day's settled FX, on top of the constant
 * cash/NAV base. Returns one {@link CurvePoint} per daily-bar instant, ascending;
 * the caller collapses them to one close per day via {@link harvestDailyCloses}.
 */
export function reconstructLongRangeCloses(input: ReconstructLongRangeInput): CurvePoint[] {
  return reconstructSessionCurve({
    holdings: toReconHoldings(input.anchor.holdings),
    barsBySymbol: input.barsBySymbol,
    fxBars: input.fxBars ?? [],
    baseFx: input.anchor.baseFx,
    baseEur: input.anchor.baseEur,
    baseUsd: input.anchor.baseUsd,
    mmDaysUsd: input.mmDaysUsd,
  });
}

/** Inputs to {@link loadOrBuildLongRangeHistory}. */
export interface LongRangeOptions {
  /** The whole-book anchor (built from the decrypted blob's holdings). */
  anchor: IntradayAnchor;
  /** Persistent store; the value history lives under `VALUE_HISTORY_STORE_KEY`. */
  store: TimeSeriesStore;
  /**
   * Fetch **daily-close** bars for the given market tickers. The caller bakes the
   * window's `startDate`/`endDate` (and a sufficient `outputsize`) into this
   * fetcher and wraps it in the shared reservation authority + per-series backoff
   * (no new bypass), so this module just calls it with the symbol list.
   */
  fetchDailyBars: BarFetcher;
  /** Fetch EUR→USD daily bars for the window; omit/null to fall back to `baseFx`. */
  fetchFx?: (() => Promise<Bar[]>) | null;
  /** Today's New-York calendar date (`exchangeDate(now)`). */
  today: string;
  /** The blob's last exported curve day, or `null`. See {@link LongRangeWindowInput}. */
  lastExportDay: string | null;
  /** Override the maximum look-back; defaults to {@link LONG_RANGE_MAX_LOOKBACK_DAYS}. */
  maxLookbackDays?: number;
  /**
   * Force a fetch even when the store already covers the window (the Regenerate
   * and hard-reset paths, which have just wiped the store and want it rebuilt).
   * Defaults to `false` — an opportunistic build only fetches a genuine gap.
   */
  force?: boolean;
  /** Reference instant for the harvest stamp (defaults to now). */
  now?: number;
  /** Per-day whole-book money-market value (USD) so the base steps per day. */
  mmDaysUsd?: { date: string; valueNativeUsd: Decimal }[];
}

/** The outcome of a long-range build. */
export interface LongRangeResult {
  /** The (possibly rebuilt) whole-book daily-close history, ascending by day. */
  history: DailyClose[];
  /** Whether the build actually fetched daily bars this round. */
  fetched: boolean;
  /** The trading days the store was missing in the window (before any fetch). */
  gapDays: string[];
  /** The market symbols whose daily bars were fetched (empty when no fetch ran). */
  symbols: string[];
}

/**
 * Reconstruct the long-range whole-book value history from scratch and harvest it
 * into the value-history store, then return the updated history.
 *
 * The build:
 *   1. computes the gap window (after the blob's last export, capped to the
 *      chart's 1Y horizon — {@link longRangeWindow});
 *   2. skips the network when the store already covers it and `force` is unset
 *      ({@link longRangeGapDays}) — the cost-minimal path;
 *   3. otherwise fetches each **market** holding's daily closes (+ daily FX) over
 *      the window, reconstructs the whole-book daily closes, and harvests them in.
 *
 * NAV funds and cash ride flat in the anchor's constant base (the caller folds
 * them there), so the historical line re-prices the market sleeve genuinely while
 * carrying the slow-moving base constant — the same simplification the 1W harvest
 * already makes for cash. Fully best-effort: a fetch failure leaves whatever the
 * store already held untouched.
 */
export async function loadOrBuildLongRangeHistory(
  options: LongRangeOptions,
): Promise<LongRangeResult> {
  const { anchor, store, fetchDailyBars, fetchFx = null } = options;
  const now = options.now ?? Date.now();
  const existing = await loadValueHistory(store);

  const window = longRangeWindow({
    today: options.today,
    lastExportDay: options.lastExportDay,
    maxLookbackDays: options.maxLookbackDays,
  });
  if (window === null || anchor.holdings.length === 0 || intradaySymbols(anchor).length === 0) {
    return { history: existing, fetched: false, gapDays: [], symbols: [] };
  }

  const days = tradingDaysInWindow(window);
  const gapDays = longRangeGapDays(existing, days);
  if (gapDays.length === 0 && !(options.force ?? false)) {
    return { history: existing, fetched: false, gapDays, symbols: [] };
  }

  // Only the **market** sleeve members are ever network-fetched as daily closes;
  // NAV funds re-mark from the constant base (the caller folds them there).
  const symbols = marketSleeveSymbols(anchor);
  if (symbols.length === 0) {
    return { history: existing, fetched: false, gapDays, symbols: [] };
  }

  let barsBySymbol: Map<string, Bar[]>;
  try {
    barsBySymbol = await fetchDailyBars(symbols);
  } catch {
    return { history: existing, fetched: false, gapDays, symbols: [] };
  }

  let fxBars: Bar[] = [];
  if (fetchFx) {
    try {
      fxBars = await fetchFx();
    } catch {
      // FX only refines the EUR pivot; a failure falls back to the settled baseFx.
      fxBars = [];
    }
  }

  const points = reconstructLongRangeCloses({ anchor, barsBySymbol, fxBars, mmDaysUsd: options.mmDaysUsd });
  // Blob-basis contract (new requirement): the blob's analytics.curve is the
  // authoritative history up to its last export, so reconstruction is *only* a
  // gap-filler. Clamp the harvested points to the window — strictly after the
  // blob's last export — so a fetcher that returns out-of-window bars can never
  // overwrite a blob-covered day (with its reinvestment/share history).
  const inWindow = points.filter((p) => {
    const day = localDayOfInstant(p.t);
    return day >= window.startDate && day <= window.endDate;
  });
  if (inWindow.length > 0) {
    await harvestDailyCloses(store, inWindow, now);
  }
  const history = await loadValueHistory(store);
  return { history, fetched: true, gapDays, symbols };
}
