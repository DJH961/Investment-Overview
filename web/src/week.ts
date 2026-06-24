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
  marketSleeveSymbols,
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
import type { Decimal } from "./decimal-config";
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

/** The `YYYY-MM-DD` UTC calendar day an epoch-ms instant falls on. */
function utcDayOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Collapse arbitrary intraday/daily price bars to **one NAV bar per UTC day**,
 * each stamped at that day's UTC midnight ({@link dayStartMs}) and carrying the
 * day's *last* (settling) value. This re-stamps a price-bar fetch (whose daily
 * bars land at 09:30/16:00 ET session instants — {@link barsFromTiingoDaily})
 * onto the **same cadence** as the NAV bars accumulated for free from quotes
 * ({@link navBarsFromQuotes}), so the gap-filled history and the free history
 * share one instant grid under a fund's symbol (item 7b). Exposed so the live
 * builder can wrap its capacity-split daily fetcher into a NAV-cadence fetcher.
 */
export function toDailyNavBars(bars: Bar[]): Bar[] {
  const byDay = new Map<string, Bar>();
  for (const b of bars) {
    const day = utcDayOf(b.t);
    const prev = byDay.get(day);
    if (!prev || b.t >= prev.t) byDay.set(day, b);
  }
  return [...byDay.entries()]
    .map(([day, b]) => ({ t: dayStartMs(day), value: b.value }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Wrap a price-bar fetcher into a daily-NAV fetcher: every fetched symbol's bars
 * are collapsed to one settling value per UTC day at day-start ({@link
 * toDailyNavBars}). Used for the item-7b gap-fill so the NAV history pulled
 * through the item-8 capacity split aligns with the free-accumulated NAV bars.
 */
export function wrapDailyNavFetcher(fetch: BarFetcher): BarFetcher {
  return async (symbols) => {
    const raw = await fetch(symbols);
    const out = new Map<string, Bar[]>();
    for (const [symbol, bars] of raw) out.set(symbol, toDailyNavBars(bars));
    return out;
  };
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

/**
 * The settled session day-start instants the week window expects a NAV bar at:
 * every trading day in the window except today while the market is still open
 * (today's NAV has not published yet — the live tip carries it). Used to judge
 * which moving-fund NAV days the stored cache is missing (item 7b).
 */
function settledSessionStarts(now: Date, sessions: number): number[] {
  const window = recentTradingSessions(sessions, now);
  const settled = isUsMarketOpen(now) ? window.slice(0, -1) : window;
  return settled.map(dayStartMs);
}

/**
 * Which **moving-fund** `navSymbols` the stored week cache is missing a daily-NAV
 * bar for on one or more settled sessions — the item-7b gap-fill set. A
 * once-per-login NAV stamp ({@link navBarsFromQuotes}) leaves interior holes when
 * a user logs in irregularly; this finds the funds whose NAV history is not yet
 * continuous across the window so their drift can be backfilled.
 *
 * **Money-market / stable-value funds must never be passed here**: their NAV is
 * pinned at ~$1 by design, so they stay flat and are never fetched (the caller —
 * `app.ts` — supplies only genuine, NAV-fetchable `mutual_fund` symbols).
 */
export function navBackfillStaleSymbols(
  stored: { bars: Record<string, Bar[]> } | null,
  navSymbols: string[],
  now: Date = new Date(),
  sessions = DEFAULT_WEEK_SESSIONS,
): string[] {
  const sessionStarts = settledSessionStarts(now, sessions);
  if (sessionStarts.length === 0) return [];
  const bars = stored?.bars ?? {};
  return navSymbols.filter((s) => {
    const have = new Set((bars[s] ?? []).map((b) => b.t));
    return sessionStarts.some((t) => !have.has(t));
  });
}

/**
 * Build the daily-NAV bars to merge into the **week** store from a refresh's
 * fund quotes — the "remember NAVs for free" step (item 7a.1). Each fund NAV is
 * already pulled for the headline total with its *authentic* strike date
 * (`Quote.valueDate`), so stamping it as a daily bar under the fund symbol
 * accumulates one NAV/fund/day at **zero** graph cost. Only `navSymbols` are
 * kept, and only quotes carrying both a positive price and a value-date.
 */
export function navBarsFromQuotes(
  quotes: Iterable<{ symbol: string; valueDate?: string | null; price: Decimal | null }>,
  navSymbols: ReadonlySet<string>,
): Record<string, Bar[]> {
  const bars: Record<string, Bar[]> = {};
  for (const q of quotes) {
    if (!navSymbols.has(q.symbol)) continue;
    if (!q.valueDate || q.price === null || !q.price.greaterThan(0)) continue;
    bars[q.symbol] = [{ t: dayStartMs(q.valueDate), value: q.price }];
  }
  return bars;
}

/** Inputs to {@link loadOrBuildWeekCurve}. */
export interface WeekCurveOptions {
  anchor: IntradayAnchor;
  /** Persistent store; the weekly cache lives under {@link WEEK_STORE_KEY}. */
  store: TimeSeriesStore;
  /** Fetch daily-close bars for the given tickers (browser-direct `interval=1day`). */
  fetchDailyBars: BarFetcher;
  /**
   * Fetch daily-**NAV** bars (one settling value per UTC day, day-start stamped —
   * see {@link wrapDailyNavFetcher}) for moving funds whose week history has gaps
   * (item 7b). Routed by the caller through the item-8 capacity split. Omit to
   * disable gap-fill; NAV funds then re-mark only from the free-accumulated bars.
   */
  fetchNavBars?: BarFetcher | null;
  /**
   * The genuine, NAV-fetchable **moving-fund** symbols eligible for the item-7b
   * gap-fill. Money-market / pinned-$1 funds must be excluded by the caller so
   * they stay flat and are never fetched.
   */
  navBackfillSymbols?: string[];
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
  /**
   * Invoked with the moving-fund symbols whose NAV history was just gap-filled
   * (item 7b) — the rare path that spends graph credits on an otherwise quiet
   * day. Lets the app surface *why* a 1W render pulled, keeping the polling log
   * self-explaining (the visibility theme of items 2 & 6). A no-op by default.
   */
  onNavBackfill?: (symbols: string[]) => void;
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
  // The full sleeve (market + any NAV funds) drives reconstruction; only the
  // **market** members are ever network-fetched as daily closes. NAV funds
  // re-mark from daily-NAV bars accumulated for free on each refresh (and the
  // item-7b gap-fill), so they never spend a graph credit here (item 7).
  const symbols = intradaySymbols(anchor);
  const fetchSymbols = marketSleeveSymbols(anchor);

  // The newest day we expect a *settled* daily close for: today only once it has
  // closed; while the market is still open, the latest settled session is the
  // window's second-to-last day (today rides on the live tip instead).
  const settledEnd = marketOpen ? (window[window.length - 2] ?? startDay) : endDay;
  const windowStartMs = dayStartMs(startDay);

  let stored = await store.loadSession(key);
  // Freshness is judged on the *fetchable* (market) symbols only — NAV funds
  // never gate a network pull, so a fund still missing a NAV day cannot force a
  // re-pull storm of the market closes (item 5b coverage, item 7 range-split).
  const fresh =
    symbols.length === 0 ||
    (stored !== null && coversThrough(stored.bars, fetchSymbols, dayStartMs(settledEnd)));

  let fxAttempted = false;
  if (!fresh) {
    const barsBySymbol = await fetchDailyBars(fetchSymbols);
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

  // Item 7b — gap-fill the daily-NAV history of *moving* funds (mutual funds)
  // whose stored week cache is missing settled-session NAV days from irregular
  // logins. Runs independently of market freshness (the market closes can be
  // fully cached while the NAV days have holes), and only ever fetches the
  // caller-vetted moving-fund symbols — money-market / pinned-$1 funds are never
  // in this set, so they stay flat and spend nothing. The fetch is routed through
  // the item-8 capacity split and re-stamped to the NAV day-start cadence.
  const navBackfillSymbols = options.navBackfillSymbols ?? [];
  const fetchNavBars = options.fetchNavBars ?? null;
  if (fetchNavBars && navBackfillSymbols.length > 0) {
    const staleNav = navBackfillStaleSymbols(stored, navBackfillSymbols, now, sessions);
    if (staleNav.length > 0) {
      if (options.onNavBackfill) options.onNavBackfill(staleNav);
      const navBars = await fetchNavBars(staleNav);
      const incomingNav: Record<string, Bar[]> = {};
      for (const [symbol, bars] of navBars) {
        if (bars.length > 0) incomingNav[symbol] = bars;
      }
      if (Object.keys(incomingNav).length > 0) {
        stored = await store.mergeSession(key, { bars: incomingNav }, now.getTime());
      }
    }
  }

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
