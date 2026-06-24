/**
 * Live **1 Week** curve orchestration for the web companion
 * (docs/v3.0_live_web_companion_proposal.md §10.8, Phase 4).
 *
 * The 1W curve is **self-built from stored daily closes**: one daily-close bar
 * per trading session across the week, reconstructed with the very same anchored
 * maths the 1D curve uses ({@link reconstructSessionCurve}) — only the bar
 * cadence differs (one bar per *day* instead of one per 5-minute interval). That
 * means the whole-book value at each day's close is
 * `base + Σ valueᵢ · closeᵢ(day)/closeᵢ`, closing on the headline total by
 * construction, with EUR genuinely re-marked at each day's FX rather than a flat
 * rescale of USD.
 *
 * Economics (§10.8): the daily closes are a **one-time `interval=1day` backfill**
 * — a single request per symbol covers the whole window (bars are free on Twelve
 * Data; 1 credit/symbol). They are persisted in the {@link TimeSeriesStore} under
 * a dedicated namespaced key, separate from the per-session 1D caches, so a
 * re-open does **not** re-fetch a week already on the device. While the market is
 * open, today's still-forming close is represented by the **live tip** (the
 * headline total at `now`), so the curve always ends on the live figure.
 *
 * The network (`fetchDailyBars`/`fetchFx`) and persistence (`store`) are injected,
 * so the whole orchestration is unit-testable with no DOM, IndexedDB, or live API.
 */

import {
  appendLiveTip,
  intradaySymbols,
  type IntradayAnchor,
  type LiveTip,
  type BarFetcher,
} from "./intraday";
import {
  isUsMarketOpen,
  lastSessionDate,
  recentTradingSessions,
} from "./market-hours";
import {
  reconstructSessionCurve,
  type Bar,
  type CurvePoint,
  type ReconHolding,
} from "./timeseries";
import { TimeSeriesStore } from "./timeseries-store";

/**
 * The store key the weekly daily-close cache lives under. Deliberately **not** a
 * `YYYY-MM-DD` date so it shares the IndexedDB store with the per-session 1D
 * caches without ever colliding with — or being swept away by — a session prune
 * (see {@link TimeSeriesStore.prune}).
 */
export const WEEK_STORE_KEY = "1W-daily";

/** Trading sessions the 1W window spans by default (a calendar week of sessions). */
export const DEFAULT_WEEK_SESSIONS = 5;

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

/** Epoch-ms of `YYYY-MM-DD` at UTC midnight — the instant a daily-close bar is stamped at. */
function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Keep only bars at or after `fromMs` (drops days that have rolled out of the window). */
function barsFrom(bars: Bar[], fromMs: number): Bar[] {
  return bars.filter((b) => b.t >= fromMs);
}

/** Whether `stored` carries a daily bar at or after `fromMs` for every needed symbol. */
function coversThrough(
  bars: Record<string, Bar[]>,
  symbols: string[],
  fromMs: number,
): boolean {
  return symbols.every((s) => (bars[s] ?? []).some((b) => b.t >= fromMs));
}

/**
 * The instant the 1W curve treats as its freshness cutoff for a given `now`: a
 * stored daily-close cache is "fresh" only if it carries a bar at/after this
 * instant for every needed symbol. While the market is open today rides on the
 * live tip, so the latest *settled* close is the window's second-to-last day;
 * otherwise it is the window's last day. Exposed so the refresh-layer dedup test
 * ({@link App.prefetchGraphStaleness}) can apply the *same* coverage test the
 * build uses, instead of a looser presence check that misfires on stale-but-
 * present stores (`docs/tiingo_polling_storm_cleanup_plan.md` item 5b).
 */
export function weekCoverageCutoffMs(now: Date = new Date(), sessions = DEFAULT_WEEK_SESSIONS): number {
  const window = recentTradingSessions(sessions, now);
  const startDay = window[0] ?? lastSessionDate(now);
  const endDay = window[window.length - 1] ?? startDay;
  const settledEnd = isUsMarketOpen(now) ? (window[window.length - 2] ?? startDay) : endDay;
  return dayStartMs(settledEnd);
}

/**
 * Which of `symbols` a stored weekly cache does **not** yet cover through the
 * settled cutoff for `now` — the stale set the 1W build would re-fetch. Mirrors
 * the build's `coversThrough(settledEnd)` test (item 5b).
 */
export function weekStaleSymbols(
  stored: { bars: Record<string, Bar[]> } | null,
  symbols: string[],
  now: Date = new Date(),
  sessions = DEFAULT_WEEK_SESSIONS,
): string[] {
  const cutoff = weekCoverageCutoffMs(now, sessions);
  const bars = stored?.bars ?? {};
  return symbols.filter((s) => !(bars[s] ?? []).some((b) => b.t >= cutoff));
}

/** Inputs to {@link loadOrBuildWeekCurve}. */
export interface WeekCurveOptions {
  anchor: IntradayAnchor;
  /** Persistent store; the weekly cache lives under {@link WEEK_STORE_KEY}. */
  store: TimeSeriesStore;
  /** Fetch daily-close bars for the given tickers (browser-direct `interval=1day`). */
  fetchDailyBars: BarFetcher;
  /** Fetch EUR→USD daily bars for the window; omit/null to fall back to `baseFx`. */
  fetchFx?: (() => Promise<Bar[]>) | null;
  /** Reference instant (defaults to now). */
  now?: Date;
  /** Live headline totals to pin as the tip while the market is open. */
  liveTip?: LiveTip | null;
  /** Trading sessions the window spans; default {@link DEFAULT_WEEK_SESSIONS}. */
  sessions?: number;
  /** Override the store key (mainly for tests). */
  storeKey?: string;
  /**
   * Invoked with the freshly fetched daily bars when a build actually spends
   * credits, so the app can prime the holdings' quote cache from each symbol's
   * newest mark. A no-op by default. See {@link SessionCurveOptions.onFreshBars}.
   */
  onFreshBars?: (barsBySymbol: Map<string, Bar[]>) => void;
}

/** A built 1W curve plus the window it covers. */
export interface WeekCurve {
  /** First trading day of the window (`YYYY-MM-DD`, New-York calendar). */
  startDay: string;
  /** Last trading day of the window — the current session. */
  endDay: string;
  /** Whole-book points, ascending; ends on the live tip while open, else the last close. */
  points: CurvePoint[];
  /** Whether the regular session was open at `now`. */
  marketOpen: boolean;
}

/**
 * Build the live 1W curve from stored daily closes, fetching at most once per
 * window advance.
 *
 * The daily closes are re-fetched only when the cache is missing a needed symbol
 * or has not yet caught up to the newest **settled** session — i.e. a genuinely
 * new trading day has closed since the last backfill. While the market is open,
 * today's not-yet-settled close is not required (the live tip carries today), so
 * an intraday re-open does not trigger a re-fetch. Newly fetched bars are merged
 * into the cache and trimmed to the window so the store does not grow unbounded;
 * the reconstruction then runs off the window's daily closes, with the live tip
 * pinned as the final point while the session is open.
 */
export async function loadOrBuildWeekCurve(options: WeekCurveOptions): Promise<WeekCurve> {
  const { anchor, store, fetchDailyBars, fetchFx = null } = options;
  const now = options.now ?? new Date();
  const sessions = options.sessions ?? DEFAULT_WEEK_SESSIONS;
  const key = options.storeKey ?? WEEK_STORE_KEY;

  const window = recentTradingSessions(sessions, now);
  const startDay = window[0] ?? lastSessionDate(now);
  const endDay = window[window.length - 1] ?? startDay;
  const marketOpen = isUsMarketOpen(now);
  const symbols = intradaySymbols(anchor);

  // The newest day we expect a *settled* daily close for: today only once it has
  // closed; while the market is still open, the latest settled session is the
  // window's second-to-last day (today rides on the live tip instead).
  const settledEnd = marketOpen ? (window[window.length - 2] ?? startDay) : endDay;
  const windowStartMs = dayStartMs(startDay);

  let stored = await store.loadSession(key);
  const fresh =
    symbols.length === 0 ||
    (stored !== null && coversThrough(stored.bars, symbols, dayStartMs(settledEnd)));

  let fxAttempted = false;
  if (!fresh) {
    const barsBySymbol = await fetchDailyBars(symbols);
    const incomingBars: Record<string, Bar[]> = {};
    for (const [symbol, bars] of barsBySymbol) {
      if (bars.length > 0) incomingBars[symbol] = bars;
    }
    if (options.onFreshBars) options.onFreshBars(barsBySymbol);
    let incomingFx: Bar[] | undefined;
    if (fetchFx) {
      fxAttempted = true;
      try {
        incomingFx = await fetchFx();
      } catch {
        // FX bars only refine the EUR pivot (each point falls back to `baseFx`);
        // a failure must never sink the price curve.
        incomingFx = undefined;
      }
    }
    stored = await store.mergeSession(key, { bars: incomingBars, fx: incomingFx }, now.getTime());
  }

  // Secondary-currency refill: when the week's daily closes are already cached
  // (so `fresh`) but the per-day FX track is missing, pull it once. Without it
  // every point rebases on the flat `baseFx` and the secondary-currency line
  // collapses onto the primary instead of diverging by the week's FX move. Gated
  // on having bars to rebase and on not having just tried FX above, so a
  // fully-loaded closed-market week never re-fires once its FX is in hand.
  const loaded = stored;
  if (
    fetchFx &&
    !fxAttempted &&
    loaded !== null &&
    loaded.fx.length === 0 &&
    symbols.some((s) => (loaded.bars[s]?.length ?? 0) > 0)
  ) {
    try {
      const incomingFx = await fetchFx();
      if (incomingFx.length > 0) {
        stored = await store.mergeSession(key, { fx: incomingFx }, now.getTime());
      }
    } catch {
      // Best-effort refinement; the curve still draws on `baseFx`.
    }
  }

  if (!stored || anchor.holdings.length === 0) {
    return { startDay, endDay, points: [], marketOpen };
  }

  // Trim the cache to the window so it stays bounded, then persist the trimmed
  // copy (a no-op when nothing rolled out). Reconstruct off the windowed closes.
  const windowedBars = new Map<string, Bar[]>();
  const trimmed: Record<string, Bar[]> = {};
  for (const [symbol, bars] of Object.entries(stored.bars)) {
    const kept = barsFrom(bars, windowStartMs);
    windowedBars.set(symbol, kept);
    trimmed[symbol] = kept;
  }
  const windowedFx = barsFrom(stored.fx, windowStartMs);
  if (trimmedDiffers(stored.bars, trimmed) || windowedFx.length !== stored.fx.length) {
    await store.saveSession({
      day: key,
      bars: trimmed,
      fx: windowedFx,
      tips: stored.tips ?? [],
      updatedAt: now.getTime(),
    });
  }

  // If the 1D curve has already been loaded this session, its fine-grained
  // intraday bars for today are sitting in the store under today's date key.
  // Splice them in over today's lone daily open/close so the freshest part of the
  // 1W line gains the same intraday detail — for free, since it is a cache read,
  // never a network fetch (we only use what a prior 1D build already paid for).
  const reconBars = windowedBars;
  let reconFx = windowedFx;
  const todayKey = lastSessionDate(now);
  const todayStartMs = dayStartMs(todayKey);
  const intraday = await store.loadSession(todayKey);
  if (intraday) {
    for (const symbol of symbols) {
      const fine = intraday.bars[symbol];
      if (!fine || fine.length === 0) continue;
      const coarse = (reconBars.get(symbol) ?? []).filter((b) => b.t < todayStartMs);
      reconBars.set(symbol, [...coarse, ...fine]);
    }
    if (intraday.fx.length > 0) {
      reconFx = [...reconFx.filter((b) => b.t < todayStartMs), ...intraday.fx];
    }
  }

  let points = reconstructSessionCurve({
    holdings: toReconHoldings(anchor.holdings),
    barsBySymbol: reconBars,
    fxBars: reconFx,
    baseFx: anchor.baseFx,
    baseEur: anchor.baseEur,
    baseUsd: anchor.baseUsd,
  });

  if (marketOpen && options.liveTip) {
    points = appendLiveTip(points, now.getTime(), options.liveTip);
  }

  return { startDay, endDay, points, marketOpen };
}

/** Whether trimming actually dropped any bar (so a re-save is worthwhile). */
function trimmedDiffers(
  before: Record<string, Bar[]>,
  after: Record<string, Bar[]>,
): boolean {
  for (const [symbol, bars] of Object.entries(before)) {
    if ((after[symbol]?.length ?? 0) !== bars.length) return true;
  }
  return false;
}
