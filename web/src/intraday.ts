/**
 * Live **1 Day** intraday curve orchestration for the web companion
 * (docs/v3.0_live_web_companion_proposal.md §10.8, Phase 2).
 *
 * This is the browser-direct baseline that ships a working 1D graph entirely on
 * the existing provider (Twelve Data `time_series`), independent of the
 * Cloudflare Worker / Tiingo pipe added in Phase 3. It ties the Phase 1
 * foundation together:
 *
 *   1. **Anchor** the whole-book curve from the *live* holdings — the
 *      intraday-priced sleeve (stocks/ETFs) is reconstructed bar-by-bar; the
 *      constant cash + NAV sleeve rides in a flat `base` (`buildIntradayAnchor`).
 *   2. **Smart-backfill** the session's price bars via {@link TimeSeriesStore},
 *      keyed by trading day, so a re-open mid-session does **not** re-fetch a day
 *      already on the device (§10.6) — at most one fetch per session, plus a
 *      refresh of the live tip while the market is open.
 *   3. **Reconstruct** the curve with the shared anchored maths
 *      ({@link reconstructSessionCurve}), then **append the live tip** (the
 *      headline total at `now`) while the session is open, or **cap at the
 *      close** once it has shut so the line ends at 16:00 ET rather than trailing
 *      flat to the wall clock.
 *
 * The network (`fetchBars`/`fetchFx`) and persistence (`store`) are injected, so
 * the whole orchestration is unit-testable with no DOM, IndexedDB, or live API.
 */

import { Decimal } from "./decimal-config";
import {
  isUsMarketOpen,
  lastSessionDate,
  previousTradingSession,
  sessionCloseMs,
} from "./market-hours";
import {
  reconstructSessionCurve,
  type Bar,
  type CurvePoint,
  type ReconHolding,
} from "./timeseries";
import { TimeSeriesStore, type Breadcrumb } from "./timeseries-store";

/**
 * One intraday-priced holding (a stock/ETF) as the curve needs it. `closeNative`
 * is the holding's *current* native mark, used as the ratio denominator so the
 * last intraday bar re-marks the live value and the curve **closes on the
 * headline total** by construction; `valueEur`/`valueUsd` are its live values.
 */
export interface IntradayHolding {
  /** The Twelve Data ticker (export `price_symbol`) — the bar map's key. */
  priceSymbol: string;
  /** Current live EUR value of the holding. */
  valueEur: Decimal;
  /** Current live USD value of the holding (FX-free; USD is booked). */
  valueUsd: Decimal;
  /** Current native price — the ratio denominator the bars re-mark from. */
  closeNative: Decimal;
  /** True when the holding is booked in USD, so its EUR view needs an FX rebase. */
  isUsdNative: boolean;
  /**
   * How this sleeve member is priced. `"market"` members get bars from the live
   * price provider (intraday for 1D, daily closes for 1W). `"nav"` members
   * (mutual funds folded into the **week** sleeve) re-mark from accumulated daily
   * NAV bars only and are **never** network-fetched as graph bars — see
   * {@link buildIntradayAnchor} `navInSleeve` and `week.ts`.
   */
  priceType: "market" | "nav";
}

/**
 * The whole-book anchor: the intraday-priced sleeve plus the constant base
 * (settled cash + NAV funds) that is added at every point.
 */
export interface IntradayAnchor {
  /** Intraday-priced holdings (ETFs/stocks). NAV funds + cash ride in `base`. */
  holdings: IntradayHolding[];
  /** Constant EUR base (cash + NAV funds) added at every point. */
  baseEur: Decimal;
  /** Constant USD base (cash + NAV funds) added at every point. */
  baseUsd: Decimal;
  /** The settled EUR→USD rate the holdings' EUR values are expressed at. */
  baseFx: Decimal | null;
}

/** Shares below this are treated as a closed-out lot, not a real holding. */
const MIN_SHARES = new Decimal("0.0000001");

/** One holding's value/price as seen by {@link buildIntradayAnchor}. */
export interface AnchorHoldingInput {
  priceSymbol: string;
  nativeCurrency: string;
  priceType: "market" | "nav";
  shares: Decimal;
  /** Current native price (live or last-known), or null when unpriced. */
  priceNative: Decimal | null;
  /** Current live EUR value, or null when it could not be valued. */
  valueEur: Decimal | null;
  /** Current live USD value, or null when FX was unavailable. */
  valueUsd: Decimal | null;
}

/**
 * Split the live book into the intraday-priced sleeve (reconstructed bar by bar)
 * and the constant cash + NAV base, ready for {@link loadOrBuildSessionCurve}.
 *
 * A holding joins the intraday sleeve only when it is market-priced, carries a
 * real share count, and has both a native price (the ratio denominator) and a
 * live EUR value; everything else — NAV funds, the unvalued, and the supplied
 * cash totals — folds into the flat base, exactly like the desktop. USD values
 * fall back to the EUR figure when no USD twin exists so the base never drops a
 * sleeve.
 *
 * When `navInSleeve` is set (the **1W** path), NAV funds that carry a real
 * price + share count *also* join the sleeve (tagged `priceType: "nav"`) so the
 * week curve re-marks them from their accumulated daily-NAV bars instead of
 * pinning them flat — the week's NAV drift is material for a NAV-heavy book
 * (`docs/tiingo_polling_storm_cleanup_plan.md` item 7). The 1D path leaves them
 * flat in the base (NAV strikes once a day, so there is no intraday NAV curve).
 */
export function buildIntradayAnchor(
  holdings: AnchorHoldingInput[],
  cashValueEur: Decimal,
  cashValueUsd: Decimal,
  baseFx: Decimal | null,
  options: { navInSleeve?: boolean } = {},
): IntradayAnchor {
  const navInSleeve = options.navInSleeve ?? false;
  const sleeve: IntradayHolding[] = [];
  let baseEur = cashValueEur;
  let baseUsd = cashValueUsd;
  for (const h of holdings) {
    const valueEur = h.valueEur;
    if (valueEur === null) continue; // unvaluable — excluded from the curve entirely
    const valueUsd = h.valueUsd ?? valueEur;
    const pricedLot =
      h.priceNative !== null &&
      !h.priceNative.isZero() &&
      h.shares.abs().greaterThan(MIN_SHARES) &&
      h.priceSymbol.length > 0;
    const inSleeve =
      pricedLot && (h.priceType === "market" || (navInSleeve && h.priceType === "nav"));
    if (inSleeve) {
      sleeve.push({
        priceSymbol: h.priceSymbol,
        valueEur,
        valueUsd,
        closeNative: h.priceNative as Decimal,
        isUsdNative: h.nativeCurrency.toUpperCase() === "USD",
        priceType: h.priceType,
      });
    } else {
      // NAV funds / cash-like rows print at most once a day — carry them flat.
      baseEur = baseEur.plus(valueEur);
      baseUsd = baseUsd.plus(valueUsd);
    }
  }
  return { holdings: sleeve, baseEur, baseUsd, baseFx };
}

/** The distinct Twelve Data tickers the intraday sleeve needs bars for. */
export function intradaySymbols(anchor: IntradayAnchor): string[] {
  return [...new Set(anchor.holdings.map((h) => h.priceSymbol))];
}

/**
 * The distinct sleeve tickers that are safe to fetch from the live **price**
 * provider — the `"market"` members only. NAV sleeve members (1W funds) re-mark
 * from accumulated daily-NAV bars and must never be network-fetched as graph
 * bars (item 7), so the week build pulls only these.
 */
export function marketSleeveSymbols(anchor: IntradayAnchor): string[] {
  return [...new Set(anchor.holdings.filter((h) => h.priceType === "market").map((h) => h.priceSymbol))];
}

/** Map the anchor's holdings into the reconstruction's holding shape. */
function toReconHoldings(holdings: IntradayHolding[]): ReconHolding[] {
  return holdings.map((h) => ({
    symbol: h.priceSymbol,
    valueEur: h.valueEur,
    valueUsd: h.valueUsd,
    closeNative: h.closeNative,
    isUsdNative: h.isUsdNative,
  }));
}

/** The live headline totals pinned as the curve's final point while open. */
export interface LiveTip {
  valueEur: Decimal;
  valueUsd: Decimal;
}

/**
 * Append (or replace) the curve's final point with the live tip at `t`.
 *
 * While the session is open the freshest headline is newer than the last 5-min
 * bar, so the curve should end on it. A tip at the same instant as the last bar
 * replaces it; an older tip is ignored (the bars are already ahead). An empty
 * curve gains the lone tip so a cold open still shows the live dot.
 */
export function appendLiveTip(points: CurvePoint[], t: number, tip: LiveTip): CurvePoint[] {
  const tipPoint: CurvePoint = { t, valueEur: tip.valueEur, valueUsd: tip.valueUsd };
  if (points.length === 0) return [tipPoint];
  const last = points[points.length - 1];
  if (t < last.t) return points;
  if (t === last.t) return [...points.slice(0, -1), tipPoint];
  return [...points, tipPoint];
}

/**
 * Cap the curve at the regular-session close: drop any point after `closeMs` so
 * the line ends at 16:00 ET once the market has shut, rather than trailing a
 * flat segment out to the current wall clock (or across a weekend). If capping
 * would remove every point (e.g. only post-close daily bars survived), the curve
 * is returned untouched rather than blanked.
 */
export function capAtClose(points: CurvePoint[], closeMs: number): CurvePoint[] {
  const kept = points.filter((p) => p.t <= closeMs);
  return kept.length > 0 ? kept : points;
}

/**
 * Splice persisted live-tip **breadcrumbs** onto the reconstructed curve so it
 * draws its own trail between the slow, credit-conscious bar re-fetches.
 *
 * Real bars are ground truth: any breadcrumb at or before the curve's freshest
 * bar instant is dropped (the bars have since caught up and re-marked that span),
 * so the trail is self-correcting — it only ever fills the gap *after* the last
 * bar, exactly where the lone moving live tip would otherwise leave the line
 * bare. Breadcrumbs are assumed ascending and instant-deduplicated (the store
 * keeps them so); an empty reconstruction falls back to the breadcrumbs alone, so
 * a cold open mid-session still shows the trail it has gathered.
 */
export function mergeBreadcrumbs(points: CurvePoint[], tips: CurvePoint[]): CurvePoint[] {
  if (tips.length === 0) return points;
  if (points.length === 0) return [...tips].sort((a, b) => a.t - b.t);
  const lastBarT = points[points.length - 1].t;
  const tail = tips.filter((tip) => tip.t > lastBarT).sort((a, b) => a.t - b.t);
  return tail.length > 0 ? [...points, ...tail] : points;
}

/**
 * Rebase a persisted breadcrumb trail onto the *current* base (settled cash + NAV
 * funds). Each crumb stored the whole-book total **and** the base it was struck
 * against; re-expressing it as `total − struckBase + currentBase` shifts the whole
 * trail by any intraday change in the base — a NAV strike, an FX move — so it joins
 * the freshly reconstructed bars without a step instead of carrying a stale floor.
 * Crumbs written before the base was recorded (no `baseEur`/`baseUsd`) pass through
 * unchanged — their whole-book total as-is, exactly the pre-rebasing behaviour.
 */
export function rebaseBreadcrumbs(
  tips: Breadcrumb[],
  baseEur: Decimal,
  baseUsd: Decimal,
): CurvePoint[] {
  return tips.map((tip) => {
    if (tip.baseEur === undefined || tip.baseUsd === undefined) {
      return { t: tip.t, valueEur: tip.valueEur, valueUsd: tip.valueUsd };
    }
    return {
      t: tip.t,
      valueEur: tip.valueEur.minus(tip.baseEur).plus(baseEur),
      valueUsd: tip.valueUsd.minus(tip.baseUsd).plus(baseUsd),
    };
  });
}

/** Native price bars fetched per Twelve Data ticker (1 credit/symbol/request). */
export type BarFetcher = (symbols: string[]) => Promise<Map<string, Bar[]>>;

/** Inputs to {@link loadOrBuildSessionCurve}. */
export interface SessionCurveOptions {
  anchor: IntradayAnchor;
  /** Persistent per-trading-day bar store (smart-backfill). */
  store: TimeSeriesStore;
  /** Fetch native price bars for the given tickers (browser-direct time_series). */
  fetchBars: BarFetcher;
  /** Fetch EUR→USD bars for the session; omit/null to fall back to `baseFx`. */
  fetchFx?: (() => Promise<Bar[]>) | null;
  /** Reference instant (defaults to now). */
  now?: Date;
  /** Live headline totals to pin as the tip while the market is open. */
  liveTip?: LiveTip | null;
  /** Trading sessions to retain in the store (rolling window); default 7. */
  retainSessions?: number;
  /**
   * The minimum age a stored session must reach before its bars are re-fetched
   * while the market is open.
   *
   * **Breadcrumbs make a cadence re-fetch unnecessary, so by default there is
   * none ({@link DEFAULT_OPEN_REFETCH_MS} is `Infinity`).** One fetch per session
   * backfills the interior bars; from then on the free live-tip *trail* (the
   * persisted breadcrumbs, see {@link appendLiveTip}/{@link mergeBreadcrumbs})
   * thickens the curve forward on every build — at roughly one point a minute,
   * *finer* than the 5-minute bars it replaces. So leaving the dashboard open for
   * hours adds **zero** further bar pulls: the data already in hand carries the
   * line, exactly as intended. Re-fetching the bars again would only re-spend a
   * free-tier credit per symbol for interior points the breadcrumbs already cover.
   *
   * Set a finite value to opt back into a periodic interior top-up (a session
   * whose bars were fetched within the window is reused as-is), or 0 to refresh
   * the bars on every open-market build (maximal resolution, maximal credit cost).
   * Missing symbols are always backfilled regardless of this window.
   */
  minRefetchMs?: number;
  /**
   * Invoked with the freshly fetched native price bars whenever a build actually
   * spends credits on a bar fetch (never on a cache-only reuse). The app wires
   * this to prime the holdings' quote cache from each symbol's newest bar, so a
   * big graph load hands the current price *back* to the holding rows — they then
   * skip a separate per-symbol quote request. A no-op by default.
   */
  onFreshBars?: (barsBySymbol: Map<string, Bar[]>) => void;
  /**
   * **Regenerate-only (Pillar 6, the decisive seam).** When `true` the build is
   * pure: it reconstructs the curve from bars already in the store (plus fresh
   * breadcrumbs) and **never** touches the network — no bar backfill, no FX
   * refill. This is the mode every *UI interaction* (a 1D/1W toggle, a graph
   * click/tap/hover) must use, so chart interaction is guaranteed network-free;
   * only the four pull mechanisms (`start`/`auto`/`manual`/`reset`) build with
   * fetching enabled. Defaults to `false` (legacy fetch-then-reconstruct).
   */
  regenerateOnly?: boolean;
}

/**
 * Default open-market bar re-fetch cadence for the live 1D curve: **disabled**
 * (`Infinity`), because the breadcrumb trail removes the need for one.
 *
 * Once a session's bars have been fetched once, the free live-tip breadcrumbs
 * carry the curve forward on every subsequent build (finer than 5-minute bars,
 * at zero credits), so a dashboard left open for hours never needs to re-buy
 * bars to stay current. A caller that wants periodic interior top-ups can pass a
 * finite `minRefetchMs`; the default trusts the data already on the device.
 */
export const DEFAULT_OPEN_REFETCH_MS = Number.POSITIVE_INFINITY;

/** A built 1D session curve plus the day it covers. */
export interface SessionCurve {
  /** Trading day the curve covers (`YYYY-MM-DD`, New-York calendar). */
  day: string;
  /** Whole-book points, ascending; closes on the headline total. */
  points: CurvePoint[];
  /** Whether the regular session was open at `now`. */
  marketOpen: boolean;
}

/**
 * Build the live 1D session curve, fetching at most once per session day.
 *
 * Fetches a symbol's bars only when the store has none for the day. It does
 * **not** re-fetch on a cadence while the market is open: the free live-tip
 * breadcrumbs (persisted on every build) thicken the curve forward for nothing,
 * so an open, auto-updating dashboard stays current without ever re-spending a
 * credit per symbol — the whole point of the breadcrumb trail. A caller can pass
 * big graph load hands the current price *back* to the holding rows — they then
 * skip a separate per-symbol quote request. A no-op by default.
 *
 * Newly fetched bars are merged into the store; the reconstruction then runs off
 * the merged session, with the breadcrumb trail spliced on after the freshest bar.
 * While open, the live tip is pinned as the final point; once closed, the curve
 * is capped at the 16:00 ET close. Older sessions are pruned to a rolling window
 * so the store does not grow unbounded.
 */
export async function loadOrBuildSessionCurve(
  options: SessionCurveOptions,
): Promise<SessionCurve> {
  const { anchor, store, fetchBars, fetchFx = null } = options;
  const now = options.now ?? new Date();
  const day = lastSessionDate(now);
  const marketOpen = isUsMarketOpen(now);
  const symbols = intradaySymbols(anchor);

  let stored = await store.loadSession(day);
  const missing = symbols.filter((s) => !(stored?.bars[s]?.length));
  // Breadcrumbs remove the need for a cadence re-fetch: once the session's bars
  // are on the device, the free live-tip trail below carries the curve forward on
  // every build (finer than the 5-min bars, at zero credits), so a long
  // open-browser watch re-spends nothing. By default (`minRefetchMs` = Infinity)
  // any stored session therefore counts as "recently fetched" and is reused as-is;
  // only *missing* symbols are ever backfilled. A finite `minRefetchMs` opts back
  // into periodic interior bar top-ups (0 = every open-market build).
  const minRefetchMs = options.minRefetchMs ?? DEFAULT_OPEN_REFETCH_MS;
  const recentlyFetched =
    stored !== null && minRefetchMs > 0 && now.getTime() - stored.updatedAt < minRefetchMs;
  const needFetch =
    !(options.regenerateOnly ?? false) &&
    symbols.length > 0 &&
    (missing.length > 0 || (marketOpen && !recentlyFetched));

  let fxAttempted = false;
  if (needFetch) {
    // Closed: only backfill the gaps. Open: refresh every symbol so the curve
    // grows to the freshest bar (still 1 credit each — bars are free).
    const fetchSymbols = marketOpen ? symbols : missing;
    const barsBySymbol = await fetchBars(fetchSymbols);
    const incomingBars: Record<string, Bar[]> = {};
    for (const [symbol, bars] of barsBySymbol) {
      if (bars.length > 0) incomingBars[symbol] = bars;
    }
    // Hand the freshly paid-for bars back to the holdings' quote cache: the
    // newest bar is a current native mark, so a holding row can skip its own
    // per-symbol quote request rather than re-buy the same price.
    if (options.onFreshBars) options.onFreshBars(barsBySymbol);
    let incomingFx: Bar[] | undefined;
    if (fetchFx) {
      fxAttempted = true;
      try {
        incomingFx = await fetchFx();
      } catch {
        // FX bars are a refinement (each point falls back to `baseFx`); a failure
        // must never sink the price curve.
        incomingFx = undefined;
      }
    }
    stored = await store.mergeSession(day, { bars: incomingBars, fx: incomingFx }, now.getTime());
  }

  // Secondary-currency refill. A self-fetched curve only diverges EUR from USD
  // when it has the day's FX track; without it `reconstructSessionCurve` falls
  // back to the flat `baseFx` for every point and the rebased secondary line
  // collapses onto the primary one. So when the price bars are already on the
  // device (no `needFetch`, e.g. a prior backfill stored bars without FX) but
  // the FX track is missing, pull it once. Gated on having bars to rebase and on
  // not having just tried FX above, so a fully-loaded closed-market curve never
  // re-fires once its FX is in hand.
  const loaded = stored;
  if (
    !(options.regenerateOnly ?? false) &&
    fetchFx &&
    !fxAttempted &&
    loaded !== null &&
    loaded.fx.length === 0 &&
    symbols.some((s) => (loaded.bars[s]?.length ?? 0) > 0)
  ) {
    try {
      const incomingFx = await fetchFx();
      if (incomingFx.length > 0) {
        stored = await store.mergeSession(day, { fx: incomingFx }, now.getTime());
      }
    } catch {
      // Best-effort refinement; the curve still draws on `baseFx`.
    }
  }

  await pruneOldSessions(store, day, options.retainSessions ?? 7);

  // Reconstruct the intraday-priced sleeve bar by bar over the session's stored
  // bars. An **empty sleeve** — an all-NAV/cash book, or a round where no market
  // holding could be priced — yields no bar points, but the curve is **not**
  // abandoned: the breadcrumb trail and live tip below still carry the whole-book
  // line, which for such a book is the flat NAV + cash base moving only as the base
  // itself is re-struck. (A `null` store simply means no bars yet — same effect.)
  const barsBySymbol = new Map<string, Bar[]>(Object.entries(stored?.bars ?? {}));
  let points = reconstructSessionCurve({
    holdings: toReconHoldings(anchor.holdings),
    barsBySymbol,
    fxBars: stored?.fx ?? [],
    baseFx: anchor.baseFx,
    baseEur: anchor.baseEur,
    baseUsd: anchor.baseUsd,
  });

  // While open, drop a breadcrumb at the live tip (free — a value already in
  // hand) and splice the gathered trail onto the curve so it self-thickens between
  // the slow bar re-fetches; real bars always supersede stale crumbs. The crumb
  // records the base it was struck against so the whole trail can be **rebased**
  // onto the current base (an intraday NAV strike / FX move) instead of leaving a
  // step where stale crumbs meet fresh bars.
  if (marketOpen && options.liveTip) {
    const tip: Breadcrumb = {
      t: now.getTime(),
      valueEur: options.liveTip.valueEur,
      valueUsd: options.liveTip.valueUsd,
      baseEur: anchor.baseEur,
      baseUsd: anchor.baseUsd,
    };
    const breadcrumbs = await store.appendTip(day, tip);
    points = mergeBreadcrumbs(
      points,
      rebaseBreadcrumbs(breadcrumbs, anchor.baseEur, anchor.baseUsd),
    );
    points = appendLiveTip(points, now.getTime(), options.liveTip);
  } else if (!marketOpen) {
    points = mergeBreadcrumbs(
      points,
      rebaseBreadcrumbs(stored?.tips ?? [], anchor.baseEur, anchor.baseUsd),
    );
    points = capAtClose(points, sessionCloseMs(day));
  }

  return { day, points, marketOpen };
}

/** Drop stored sessions older than `retainSessions` trading days back from `day`. */
async function pruneOldSessions(
  store: TimeSeriesStore,
  day: string,
  retainSessions: number,
): Promise<void> {
  if (retainSessions <= 1) return;
  let floor = day;
  for (let i = 1; i < retainSessions; i += 1) floor = previousTradingSession(floor);
  await store.prune(floor);
}
