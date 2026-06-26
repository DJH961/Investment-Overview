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
  rebaseBreadcrumbs,
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
  PROBE_MIN_MS,
  FX_PROBE_KEY,
  closeProbeReady,
  resolveCloseCompleteness,
  resolveFxCompleteness,
  type CloseProbeBackoff,
  type CloseResolveLog,
} from "./close-completeness";
import {
  reconstructSessionCurve,
  type Bar,
  type CurvePoint,
  type ReconHolding,
} from "./timeseries";
import type { Decimal } from "./decimal-config";
import { TimeSeriesStore, type StoredSession, type StoredCloseProbe } from "./timeseries-store";

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

/** Milliseconds in a calendar day — the span a single trading day's bars/crumbs occupy. */
const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Of the moving-fund NAV bars just (re)fetched for the week, which now carry a
 * settled NAV **tip** that reaches `settledDate` — i.e. their headline NAV is
 * genuinely current. Only these may be dropped from the separate NAV quote leg.
 *
 * A fund whose freshest fetched bar is still *behind* `settledDate` is
 * deliberately **excluded**: the bar source (Tiingo `/price` daily) did not
 * actually freshen it this round, so it must stay on the quote leg for a real
 * fetch (which can reach Twelve Data, a potentially-fresher NAV source) instead
 * of being pinned on an old day with the quote skipped. `settledDate` is the
 * `YYYY-MM-DD` of {@link latestSettledSessionDate}; the tip's UTC day is compared
 * lexically against it (ISO dates sort chronologically).
 */
export function navTipCoveredSymbols(
  barsBySymbol: Map<string, Bar[]>,
  settledDate: string,
): string[] {
  const covered: string[] = [];
  for (const [symbol, bars] of barsBySymbol) {
    if (bars.length === 0) continue;
    const tip = Math.max(...bars.map((b) => b.t));
    if (utcDayOf(tip) >= settledDate) covered.push(symbol);
  }
  return covered;
}

/**
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
  /**
   * The **secondary** EUR/USD daily leg for the after-close FX escalation (plan
   * C5 currency parity). Asked once when the primary cannot advance the FX track
   * to the settled close; two sources agreeing settle the day's FX. Omit/null to
   * resolve FX on the primary alone.
   */
  fetchSecondaryFx?: (() => Promise<Bar[]>) | null;
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
  /**
   * **Regenerate-only (Pillar 6, the decisive seam).** When `true` the 1W build
   * is pure: it reconstructs from the stored daily closes (plus the live tip) and
   * **never** fetches — no daily-close backfill, no NAV gap-fill, no FX refill. UI
   * interaction (a 1D/1W toggle, a graph click) must use this so the render path
   * is guaranteed network-free; only the four pull mechanisms build with fetching
   * enabled. Defaults to `false`. See {@link SessionCurveOptions.regenerateOnly}.
   */
  regenerateOnly?: boolean;
  /**
   * The **secondary** provider leg (Tiingo daily) for the after-close escalation
   * (plan C5): when the primary stops advancing a behind market symbol toward the
   * settled close, the second source is asked **once** whether a later daily close
   * exists. Two sources agreeing settle the symbol for the day. Omit/null to
   * disable the escalation.
   */
  fetchSecondaryDailyBars?: BarFetcher | null;
  /** Outage back-off for the week close resolution (plan C5/C4). Omit to disable. */
  closeBackoff?: CloseProbeBackoff | null;
  /** Back-off key scope for the week close resolution (default `"close:1W"`). */
  closeBackoffScope?: string;
  /** Minimum spacing between probes of an unsettled behind symbol (default {@link PROBE_MIN_MS}). */
  probeMinMs?: number;
  /** One structured verdict event per resolved behind symbol (plan C6). */
  onCloseResolve?: (event: CloseResolveLog) => void;
  /** Render a bar instant for the close-resolution log (defaults to raw ms). */
  formatInstant?: (t: number) => string;
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
  const nowMs = now.getTime();
  const settledCutoff = dayStartMs(settledEnd);
  // Half a day of slack for the daily advance/agreement comparison: daily closes
  // are day-start stamped, so consecutive sessions sit 24h apart (a real advance)
  // while two providers' same-day close differ by < 12h (an agreement). The
  // *reached-close* test stays exact (covers the settled cutoff, `completeTol=0`).
  const dailyTol = DAY_MS / 2;
  const closeProbeFor = (s: string): StoredCloseProbe | undefined => stored?.closeProbe?.[s];
  const closeBackoff = options.closeBackoff ?? null;
  const closeScope = options.closeBackoffScope ?? "close:1W";
  const closeKey = (s: string): string => `${closeScope}:${s}`;
  const probeMinMs = options.probeMinMs ?? PROBE_MIN_MS;
  const coversSymbol = (s: string): boolean =>
    (stored?.bars[s] ?? []).some((b) => b.t >= settledCutoff);
  // A fetchable market symbol is either wholly missing (no stored daily bars) or
  // *behind* the settled cutoff. A behind symbol the resolution has **settled**
  // (two providers agree no newer daily close exists) is excluded (plan C2/C5),
  // and an unsettled behind symbol is held flat between probes (plan C4 spacing).
  const whollyMissing = fetchSymbols.filter((s) => !stored?.bars[s]?.length);
  const behind = fetchSymbols.filter(
    (s) => (stored?.bars[s]?.length ?? 0) > 0 && !coversSymbol(s) && !closeProbeFor(s)?.settled,
  );
  const fetchableBehind = behind.filter((s) => {
    if (closeBackoff?.suppressed(closeKey(s), nowMs)) return false;
    return closeProbeReady(closeProbeFor(s), nowMs, probeMinMs);
  });
  // Freshness is judged on the *fetchable* (market) symbols only — NAV funds
  // never gate a network pull, so a fund still missing a NAV day cannot force a
  // re-pull storm of the market closes (item 5b coverage, item 7 range-split).
  const fresh =
    (options.regenerateOnly ?? false) ||
    symbols.length === 0 ||
    (whollyMissing.length === 0 && fetchableBehind.length === 0);

  let fxAttempted = false;
  if (!fresh) {
    const incomingBars: Record<string, Bar[]> = {};
    const fetchedAll = new Map<string, Bar[]>();
    let incomingProbe: Record<string, StoredCloseProbe> | undefined;
    let probeClear: string[] | undefined;
    // Wholly-missing symbols backfill the normal way (the capacity split's
    // emptiness spill already escalates a never-seen symbol to the secondary).
    if (whollyMissing.length > 0) {
      const barsBySymbol = await fetchDailyBars(whollyMissing);
      for (const [symbol, bars] of barsBySymbol) {
        fetchedAll.set(symbol, bars);
        if (bars.length > 0) incomingBars[symbol] = bars;
      }
    }
    // Behind-but-present symbols go through the progress → escalate → settle
    // resolution at daily granularity (plan C5).
    if (fetchableBehind.length > 0) {
      const resolution = await resolveCloseCompleteness({
        symbols: fetchableBehind,
        storedBars: stored?.bars ?? {},
        probes: stored?.closeProbe,
        closeMs: settledCutoff,
        tol: dailyTol,
        completeTol: 0,
        clampBars: (bars) => bars,
        fetchPrimary: fetchDailyBars,
        fetchSecondary: options.fetchSecondaryDailyBars ?? null,
        now: nowMs,
        backoff: closeBackoff,
        backoffKey: closeKey,
        log: options.onCloseResolve,
        label: "1W",
        formatInstant: options.formatInstant,
      });
      for (const [s, b] of resolution.fetched) fetchedAll.set(s, b);
      for (const [s, b] of Object.entries(resolution.bars)) incomingBars[s] = b;
      if (Object.keys(resolution.closeProbe).length > 0) incomingProbe = resolution.closeProbe;
      if (resolution.closeProbeClear.length > 0) probeClear = resolution.closeProbeClear;
    }
    if (options.onFreshBars) options.onFreshBars(fetchedAll);
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
    stored = await store.mergeSession(
      key,
      { bars: incomingBars, fx: incomingFx, closeProbe: incomingProbe, closeProbeClear: probeClear },
      now.getTime(),
    );
  }

  // Item 7b — gap-fill the daily-NAV history of *moving* funds (mutual funds)
  // whose stored week cache is missing settled-session NAV days from irregular
  // logins. Runs independently of market freshness (the market closes can be
  // fully cached while the NAV days have holes), and only ever fetches the
  // caller-vetted moving-fund symbols — money-market / pinned-$1 funds are never
  // in this set, so they stay flat and spend nothing. The fetch is routed through
  // the item-8 capacity split and re-stamped to the NAV day-start cadence.
  const navBackfillSymbols = options.navBackfillSymbols ?? [];
  const fetchNavBars = (options.regenerateOnly ?? false) ? null : options.fetchNavBars ?? null;
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

  // After-close **FX completeness** for the 1W window (currency parity with the
  // daily-close settle). The EUR/USD daily track has the same failure mode as a
  // quiet symbol: pulled only when *wholly missing*, an FX track that is present
  // but does not yet carry the settled session's close would leave the rebased
  // EUR line stuck on a stale daily rate, while an unconditional refill would
  // re-pull FX on every render. So route FX through the same progress → escalate
  // → settle resolution at daily granularity: advance it to the settled close,
  // remember a settle (no per-render re-pull), and only probe on the spaced,
  // back-off-bounded cadence. `regenerateOnly` stays fully network-free.
  const loaded = stored;
  if (
    !(options.regenerateOnly ?? false) &&
    fetchFx &&
    !fxAttempted &&
    loaded !== null &&
    symbols.some((s) => (loaded.bars[s]?.length ?? 0) > 0)
  ) {
    const fxProbe = loaded.closeProbe?.[FX_PROBE_KEY];
    const fxComplete = loaded.fx.some((b) => b.t >= settledCutoff);
    const fxKey = closeKey(FX_PROBE_KEY);
    const fxSpaced = fxProbe ? !closeProbeReady(fxProbe, nowMs, probeMinMs) : false;
    const fxFetchable =
      !(fxProbe?.settled ?? false) &&
      !(closeBackoff?.suppressed(fxKey, nowMs) ?? false) &&
      !fxSpaced &&
      (loaded.fx.length === 0 || !fxComplete);
    if (fxFetchable) {
      try {
        const fxRes = await resolveFxCompleteness({
          storedFx: loaded.fx,
          probe: fxProbe,
          closeMs: settledCutoff,
          tol: dailyTol,
          completeTol: 0,
          clampBars: (bars) => bars,
          fetchPrimary: fetchFx,
          fetchSecondary: options.fetchSecondaryFx ?? null,
          now: nowMs,
          backoff: closeBackoff,
          backoffKey: fxKey,
          log: options.onCloseResolve,
          label: "1W",
          formatInstant: options.formatInstant,
        });
        if (fxRes.fx !== undefined || fxRes.probe !== undefined || fxRes.probeClear) {
          stored = await store.mergeSession(
            key,
            {
              fx: fxRes.fx,
              closeProbe: fxRes.probe ? { [FX_PROBE_KEY]: fxRes.probe } : undefined,
              closeProbeClear: fxRes.probeClear ? [FX_PROBE_KEY] : undefined,
            },
            now.getTime(),
          );
        }
      } catch {
        // Best-effort refinement; the curve still draws on `baseFx`.
      }
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
    const trimmedSession: StoredSession = {
      day: key,
      bars: trimmed,
      fx: windowedFx,
      tips: stored.tips ?? [],
      updatedAt: now.getTime(),
    };
    // Preserve the week's close-probe memory across the window trim (plan C5).
    if (stored.closeProbe) trimmedSession.closeProbe = stored.closeProbe;
    await store.saveSession(trimmedSession);
  }

  // Enrich the coarse weekly closes with cached per-day 1D detail — for free,
  // since every window day's 1D session (fine intraday bars + free live-tip
  // breadcrumbs) was already paid for by a prior 1D build; this only reads what
  // the cache already holds, never the network. For each day in the window:
  //   1. its lone coarse close is replaced by that day's fine intraday bars (and
  //      FX), so the reconstructed line gains intraday shape; and
  //   2. its live-tip breadcrumb trail is rebased onto the current base and
  //      spliced into the gaps between reconstructed points (after the day's
  //      freshest real bar — bars stay ground truth), so a day the dashboard
  //      watched live thickens out even where no extra bars were fetched.
  const reconBars = windowedBars;
  let reconFx = windowedFx;
  const crumbsByDay = new Map<string, CurvePoint[]>();
  for (const day of window) {
    const session = await store.loadSession(day);
    if (!session) continue;
    const dayStart = dayStartMs(day);
    const dayEnd = dayStart + DAY_MS;
    for (const symbol of symbols) {
      const fine = session.bars[symbol];
      if (!fine || fine.length === 0) continue;
      // Drop this day's coarse close, keep every other day's, splice the fine bars in.
      const coarse = (reconBars.get(symbol) ?? []).filter(
        (b) => b.t < dayStart || b.t >= dayEnd,
      );
      reconBars.set(symbol, [...coarse, ...fine]);
    }
    if (session.fx.length > 0) {
      reconFx = [...reconFx.filter((b) => b.t < dayStart || b.t >= dayEnd), ...session.fx];
    }
    if (session.tips && session.tips.length > 0) {
      crumbsByDay.set(day, rebaseBreadcrumbs(session.tips, anchor.baseEur, anchor.baseUsd));
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

  // Splice each window day's rebased breadcrumb trail into the gaps so the line
  // thickens where it was watched live but no extra bars were fetched.
  points = spliceWeekBreadcrumbs(points, crumbsByDay);

  if (marketOpen && options.liveTip) {
    points = appendLiveTip(points, now.getTime(), options.liveTip);
  }

  return { startDay, endDay, points, marketOpen };
}

/**
 * Splice each window day's rebased breadcrumb trail into the gaps of the
 * reconstructed weekly curve.
 *
 * The crumbs are already rebased onto the *current* base; they are merged in
 * **per day** with the same "real bars are ground truth" rule the 1D curve uses
 * ({@link mergeBreadcrumbs}): only crumbs falling *after* the day's freshest
 * reconstructed bar are kept. A coarse-only day's lone close sits at UTC
 * midnight, so its whole intraday trail fills the otherwise-flat gap; a day whose
 * fine 1D bars were spliced keeps only the crumbs past its last bar. The result
 * stays ascending so the live tip can still pin cleanly onto the end.
 */
function spliceWeekBreadcrumbs(
  points: CurvePoint[],
  crumbsByDay: Map<string, CurvePoint[]>,
): CurvePoint[] {
  if (crumbsByDay.size === 0) return points;
  const extra: CurvePoint[] = [];
  for (const [day, crumbs] of crumbsByDay) {
    const dayStart = dayStartMs(day);
    const dayEnd = dayStart + DAY_MS;
    // The day's freshest real bar among the reconstructed points, or the instant
    // just before the day when it contributed no bar at all.
    let lastBarT = dayStart - 1;
    for (const p of points) {
      if (p.t >= dayStart && p.t < dayEnd && p.t > lastBarT) lastBarT = p.t;
    }
    for (const c of crumbs) {
      if (c.t > lastBarT && c.t >= dayStart && c.t < dayEnd) extra.push(c);
    }
  }
  if (extra.length === 0) return points;
  return [...points, ...extra].sort((a, b) => a.t - b.t);
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
