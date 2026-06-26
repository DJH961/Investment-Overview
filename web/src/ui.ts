/**
 * DOM rendering. Everything is built with `document.createElement` and
 * `textContent` (never `innerHTML` with interpolated data) so decrypted
 * financial figures can never be interpreted as markup — a small XSS guard on
 * data that, while local, is user-sensitive.
 *
 * The layout is deliberately mobile-first (see web/README.md): a single column
 * with a headline value, the today/month/year return horizons, a compact KPI
 * grid, and holdings as a scannable list. Wider screens get more room via CSS
 * media queries only — the markup stays the same.
 */
import { Decimal } from "./decimal-config";
import type { AllocationSlice, DashboardModel, HoldingView, MoverEntry, OverviewView } from "./compute";
import { buildMovers, fxSinceAnchorPct } from "./compute";
import { fxEffectSplit, fxBuyingPowerSplit } from "./session-fx";
import { getInvestmentAmountEur } from "./investment-amount";
import {
  isUsMarketOpen,
  isUsMarketHoliday,
  isForexMarketOpen,
  forexMarketReopenMs,
  lastForexReopenMs,
  lastSessionDate,
  exchangeDate,
  sessionOpenMs,
} from "./market-hours";
import { windowGrowthPct, type GrowthMode, type WindowPoint } from "./window-growth";
import {
  type AnalyticsView,
  type DepositRowView,
  type DepositsView,
  type EquityPoint,
  type PeriodRowView,
  type PeriodsView,
  type PlanView,
  type RiskMetric,
  computeDrawdownSeries,
} from "./phase4";
import {
  bandRates,
  finalPoint,
  requiredContribution,
  simulate,
  timeToTarget,
  totalContributed,
  type ProjectionParams,
  SCENARIO_EXPECTED,
  SCENARIO_OPTIMISTIC,
  SCENARIO_PESSIMISTIC,
} from "./projection";
import {
  formatAsOf,
  formatLastPull,
  formatCurrency,
  formatCurrencyShortRaw,
  formatCurrencyWhole,
  formatMoneyRaw,
  formatDualCurrency,
  formatDualCurrencyParts,
  type DualCurrencyParts,
  formatFxRate,
  formatMoneyEur,
  formatMoneyUsd,
  formatNativePrice,
  formatPercent,
  formatShares,
  formatSignedCurrency,
  formatSignedDualCurrency,
  formatSignedMoneyEur,
  formatSignedMoneyUsd,
  formatSignedPercent,
  formatSessionDayLabel,
  formatExportedAt,
  formatForexReopen,
  signClass,
} from "./format";
import { computeCurrencyEffect } from "./currency-effect";
import { cycleTheme, loadTheme, themeButtonContent } from "./theme";
import { getTimeFormat, setTimeFormat, type TimeFormat } from "./time-format";
import {
  canConvertToUsd,
  convertFromEur,
  convertToEur,
  getDisplayCurrency,
  pickByCurrency,
  toggleDisplayCurrency,
  type DisplayCurrency,
} from "./currency";
import { buildLineChart, type ChartSeries } from "./chart";
import { curveColumns } from "./value-graph";
import type { CurvePoint } from "./timeseries";
import type { DailyClose } from "./value-history";
import { APP_VERSION } from "./version";
import {
  expandCategoryWeights,
  planRebalance,
  scaleTo100,
  type RebalancePlan,
  type RebalanceRow,
} from "./allocation";
import {
  UNCATEGORIZED,
  type CalcCategory,
  type CalcData,
  type CalcInstrument,
  type SavedTarget,
} from "./calculator";

type Attrs = Record<string, string>;

export function h(tag: string, attrs: Attrs = {}, children: Array<Node | string> = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Up/down/flat glyph for a signed figure (pairs with the colourblind colours). */
function trendGlyph(cls: "pos" | "neg" | "flat"): string {
  if (cls === "pos") return "▲";
  if (cls === "neg") return "▼";
  return "—";
}

function signedPercentOrDash(value: Decimal | null): string {
  return value === null ? "—" : formatSignedPercent(value);
}

/**
 * The single session word the whole app uses for the "today's move" figure.
 *
 * Every surface that shows the close-to-now daily move — the hero, the "Today"
 * return segment, the per-holding row — describes the *same* session the 1D curve
 * draws. Sharing this one helper keeps that wording consistent everywhere: "today"
 * only while the current exchange day is trading, else "yesterday" or the older
 * session's date (e.g. "20 Jun"), so a weekend/holiday close is never mislabelled
 * "today" on one surface while reading honestly on another.
 */
function sessionMoveWord(now: Date = new Date()): string {
  return formatSessionDayLabel(lastSessionDate(now), exchangeDate(now));
}

/** The {@link sessionMoveWord}, capitalised for use as a standalone label. */
function sessionMoveLabel(now: Date = new Date()): string {
  const word = sessionMoveWord(now);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The headline portfolio value + today's move — the hero of the screen. */
function renderHero(o: OverviewView, now: Date = new Date()): HTMLElement {
  // Today's move is currency-correct: in USD display we prefer the USD figures so
  // the headline daily change reflects the dollar view, not the EUR view rescaled.
  const todayMovePct = pickByCurrency(o.todayMovePct, o.todayMovePctUsd);
  const cls = signClass(pickByCurrency(o.todayMoveEur, o.todayMoveUsd));
  // The hero's move is the same close-to-now figure the 1D curve draws, so it
  // shares the curve's session word: "today" only when the market is open on the
  // current day, else "yesterday" or the older session's date — never naming a
  // weekend/holiday close "today".
  const moveLabel = sessionMoveWord(now);
  const change = h("div", { class: `hero-change ${cls}` }, [
    h("span", { class: "hero-badge" }, [
      h("span", { class: "hero-arrow", "aria-hidden": "true" }, [trendGlyph(cls)]),
      formatSignedDualCurrency(o.todayMoveEur, o.todayMoveUsd),
    ]),
    h("span", { class: "hero-change-pct" }, [
      todayMovePct !== null ? `${formatSignedPercent(todayMovePct)} ${moveLabel}` : moveLabel,
    ]),
  ]);

  // The headline value and today's move. The "as of" date/time caption is no
  // longer shown here — the value-basis chip (top right) carries that signal,
  // reading "Live" while the session is open or a "Today"/date tag otherwise.
  const children: Array<Node | string> = [
    renderValueBasisChip(o, now),
    h("span", { class: "hero-label" }, ["Total value"]),
    h("span", { class: "hero-value" }, [formatCurrency(o.totalValueEur)]),
    change,
  ];
  return h("section", { class: "hero" }, children);
}

/**
 * The value-basis chip that sits at the top-right of the hero. It tells the user
 * what the headline total is based on:
 *   - a green pulsing "Live" while the NYSE session is open AND we hold a
 *     same-day quote (`pricesAreLive`);
 *   - otherwise a calm "Today" tag when the freshest price the value is built
 *     from is from today, or the date it is from ("20 Jun") when it is older —
 *     so a settled close, weekend, or holiday value reads honestly as the day it
 *     applies to rather than being dressed up as live.
 */
function renderValueBasisChip(o: OverviewView, now: Date = new Date()): HTMLElement {
  if (o.pricesAreLive) {
    return h("span", { class: "market-status market-status-live", role: "status" }, [
      h("span", { class: "market-status-dot", "aria-hidden": "true" }, []),
      "Live",
    ]);
  }
  return h("span", { class: "market-status market-status-closed", role: "status" }, [
    valueBasisLabel(o, now),
  ]);
}

/**
 * The short date label for a non-live value-basis chip: "Today" when the value's
 * freshest price is from today, else the day it is from ("Fri 20 Jun"). Uses the
 * latest live observation when present, falling back to the latest known
 * value-date (`liveAsOfFallbackDate`).
 */
function valueBasisLabel(o: OverviewView, now: Date = new Date()): string {
  const isToday = (d: Date): boolean =>
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (o.liveAsOf != null) {
    const when = new Date(o.liveAsOf);
    if (!Number.isNaN(when.getTime())) {
      if (isToday(when)) return "Today";
      return when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    }
  }
  const parsed = new Date(o.liveAsOfFallbackDate);
  if (Number.isNaN(parsed.getTime())) return o.liveAsOfFallbackDate;
  if (isToday(parsed)) return "Today";
  return parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * The currency box's market-state regime, derived purely from `now` and the
 * US-equity / spot-FX clocks. Extracted so the (DOM-free) decision can be unit
 * tested in isolation and shared between {@link renderFxBox} and
 * {@link renderFxEffect} without drift.
 *
 * The regimes, in precedence order:
 *   - **forexFrozen** — the spot-FX weekend close (Fri ≥17:00 ET, all Saturday,
 *     Sun <17:00 ET). The rate is frozen at Friday's close, so the box shows the
 *     *whole Friday session view*, frozen exactly as it looked at 17:01 ET (Today
 *     = the full session move, the "Since close" stat, the two-leg split), badged
 *     "Market closed". This is a {@link sessionView}.
 *   - **marketOpen** — the live US session; the regular live view (a sessionView).
 *   - **weekendOvernight** — forex has reopened (Sun ≥17:00 ET) but no US session
 *     has opened since: Sunday evening through Monday's 09:30 open (extending past a
 *     Monday holiday to the next real open). The only honest move is the single
 *     overnight drift since Friday's close — no stale Friday market-hours leg.
 *   - **holiday** — a US market holiday that is *not* an FX holiday (e.g. 4th of
 *     July): forex trades but the US session is shut, so likewise a single
 *     overnight number, kept under its "Market holiday" wording.
 *   - otherwise a **regular weekday post-close / pre-open** (a sessionView).
 *
 * `singleOvernight` (holiday ∨ weekendOvernight, with forex open and US shut) marks
 * the two one-number, no-split regimes; `sessionView` (its complement) marks the
 * three-stat, two-leg-split regimes.
 */
export interface FxBoxRegime {
  marketOpen: boolean;
  forexOpen: boolean;
  holiday: boolean;
  forexFrozen: boolean;
  weekendOvernight: boolean;
  singleOvernight: boolean;
  sessionView: boolean;
}

export function fxBoxRegime(now: Date = new Date()): FxBoxRegime {
  const marketOpen = isUsMarketOpen(now);
  const forexOpen = isForexMarketOpen(now);
  const holiday = isUsMarketHoliday(now);
  const forexFrozen = !forexOpen;
  const weekendOvernight =
    forexOpen &&
    !marketOpen &&
    !holiday &&
    sessionOpenMs(lastSessionDate(now)) < lastForexReopenMs(now);
  const singleOvernight = forexOpen && !marketOpen && (holiday || weekendOvernight);
  const sessionView = !singleOvernight;
  return {
    marketOpen,
    forexOpen,
    holiday,
    forexFrozen,
    weekendOvernight,
    singleOvernight,
    sessionView,
  };
}

/**
 * The standalone **Currency · EUR ↔ USD** box that sits full-width beneath the
 * Today/Month/Year return horizons (it used to be crammed under the headline
 * total). It carries three things: the live EUR/USD rate (the "current value"),
 * how far that rate has moved today (the "growth rate"), and the FX effect on
 * the book today.
 *
 * The book is **USD-booked**, so the FX move is only real money when measured
 * back in EUR. In USD display the effect on the dollar value is exactly zero —
 * the rate moving does not hand you a single extra dollar — so we say that
 * plainly and surface the EUR-repatriation figure instead of printing a
 * meaningless dollar amount. Returns null only when there is no rate at all.
 */
export function renderFxBox(o: OverviewView, now: Date = new Date()): HTMLElement | null {
  if (o.fxRateEurUsd === null) return null;
  const inUsd = getDisplayCurrency() === "USD";

  // The rate + today's move. USD display shows the stored EUR/USD spot directly;
  // EUR display shows USD/EUR (its reciprocal). The % still follows the currency
  // strength convention used here (negated for the reciprocal).
  const { marketOpen, forexFrozen, weekendOvernight, singleOvernight, sessionView } =
    fxBoxRegime(now);

  // "Today" baseline. Live: since the *prior close* (overnight + intraday so far).
  // Single-overnight: the lone drift since the last session close — Friday's FX
  // close for the weekend spill-over (or the settled previous close as a holiday's
  // overnight). Session view (open or shut): the full move since this — or Friday's
  // frozen — session open, so it never just mirrors the "Since close" stat beside it.
  let todayAnchor: Decimal | null;
  let todaySub: string;
  if (marketOpen) {
    todayAnchor = o.fxRateEurUsdPrev;
    todaySub = "since last close";
  } else if (singleOvernight) {
    todayAnchor = weekendOvernight
      ? (o.fxRateEurUsdSessionClose ?? o.fxRateEurUsdPrev)
      : o.fxRateEurUsdPrev;
    todaySub = "overnight";
  } else {
    todayAnchor = o.fxRateEurUsdSessionOpen;
    todaySub = "since last open";
  }
  const devPct = fxSinceAnchorPct(o, todayAnchor);
  const rate = inUsd ? o.fxRateEurUsd : new Decimal(1).dividedBy(o.fxRateEurUsd);
  const dev = devPct === null ? null : inUsd ? devPct : devPct.negated();
  const pair = inUsd ? "EUR/USD" : "USD/EUR";

  // The "when is this rate from" stamps: an intraday clock/date when we have an
  // observation time, and the honest "end-of-day FX" tag for the keyless ECB
  // fallback that carries no intraday timestamp.
  const stamps: HTMLElement[] = [];
  if (o.fxObservedAt !== null) {
    const when = new Date(o.fxObservedAt);
    const title = Number.isNaN(when.getTime())
      ? undefined
      : `EUR/USD rate observed ${when.toLocaleString()}`;
    stamps.push(
      h("span", title ? { class: "fx-box-asof", title } : { class: "fx-box-asof" }, [
        `as of ${formatAsOf(o.fxObservedAt, o.liveAsOfFallbackDate, now)}`,
      ]),
    );
  }
  if (o.eurUsdSource === "eod") {
    stamps.push(h("span", { class: "fx-box-eod" }, ["end-of-day FX"]));
  }

  const rateStat = h("div", { class: "fx-box-stat" }, [
    h("span", { class: "fx-box-stat-label" }, [pair]),
    h("span", { class: "fx-box-stat-value" }, [formatFxRate(rate)]),
    ...(stamps.length > 0 ? [h("span", { class: "fx-box-stat-sub" }, stamps)] : []),
  ]);
  const moveStat = h("div", { class: "fx-box-stat" }, [
    h("span", { class: "fx-box-stat-label" }, ["Today"]),
    h("span", { class: `fx-box-stat-value ${signClass(dev)}` }, [
      dev !== null ? formatSignedPercent(dev) : "—",
    ]),
    h("span", { class: "fx-box-stat-sub" }, [todaySub]),
  ]);

  // Third number: how far the rate has moved since the current session's reference
  // point — since the open while the market is live, since the close once shut.
  // Same strength convention as the "Today" move (negated for the EUR reciprocal).
  // Dropped in the single-overnight regimes (weekend spill-over, US-only holiday):
  // there is only one honest move to show, so a second stat would just echo the
  // overnight "Today" figure beside it.
  const stats: HTMLElement[] = [rateStat, moveStat];
  if (sessionView) {
    const anchorFx = marketOpen ? o.fxRateEurUsdSessionOpen : o.fxRateEurUsdSessionClose;
    const sincePctRaw = fxSinceAnchorPct(o, anchorFx);
    const sincePct = sincePctRaw === null ? null : inUsd ? sincePctRaw : sincePctRaw.negated();
    const sinceLabel = marketOpen ? "Since open" : "Since close";
    stats.push(
      h("div", { class: "fx-box-stat" }, [
        h("span", { class: "fx-box-stat-label" }, [sinceLabel]),
        h("span", { class: `fx-box-stat-value ${signClass(sincePct)}` }, [
          sincePct !== null ? formatSignedPercent(sincePct) : "—",
        ]),
        h("span", { class: "fx-box-stat-sub" }, ["rate move"]),
      ]),
    );
  }

  const statsClass = stats.length === 2 ? "fx-box-stats fx-box-stats-pair" : "fx-box-stats";
  // Over the weekend forex close, badge the box plainly and stamp when it reopens,
  // so the frozen Friday rate is never mistaken for a live one.
  const head: HTMLElement[] = [h("span", { class: "fx-box-title" }, ["Currency · EUR ↔ USD"])];
  if (forexFrozen) {
    head.push(h("span", { class: "fx-box-closed", title: "Forex market closed for the weekend" }, ["Market closed"]));
  }
  const children: HTMLElement[] = [
    h("div", { class: "fx-box-head" }, head),
    h("div", { class: statsClass }, stats),
  ];
  if (forexFrozen) {
    children.push(
      h("div", { class: "fx-box-reopen" }, [
        `Frozen at Friday's close · ${formatForexReopen(forexMarketReopenMs(now), now)}`,
      ]),
    );
  }
  const effect = renderFxEffect(o, now);
  if (effect) children.push(effect);
  return h("section", { class: "fx-box", "aria-label": "Currency EUR to USD" }, children);
}

/** Half the diverging track: a full-magnitude leg spans this much, leaving the
 *  opposite half free for a leg pulling the other way. */
const HALF_TRACK_PCT = 50;

/**
 * One leg of the diverging FX bar. The status label stands alone in its own
 * (nowrap) column; the formatted value and the live/last tag are **stacked
 * vertically in a value cell on the right**, so the tag never sits inline with
 * the status word — and "Market holiday", "Market hours" and "Overnight" can't be
 * pushed onto a second line by the tag crowding the narrow label column.
 */
function fxDivergeRow(opts: {
  label: string;
  value: Decimal;
  formatted: string;
  overnightLeg: boolean;
  live: boolean;
  widthPct: number;
}): HTMLElement {
  const { label, value, formatted, overnightLeg, live, widthPct } = opts;
  const fill = h(
    "span",
    { class: `fx-diverge-fill ${signClass(value)}${overnightLeg ? " fx-diverge-overnight" : ""}` },
    [],
  );
  fill.style.width = `${widthPct}%`;
  return h("div", { class: "fx-diverge-row" }, [
    h("span", { class: "fx-diverge-label" }, [label]),
    h("div", { class: "fx-diverge-track", "aria-hidden": "true" }, [fill]),
    h("span", { class: "fx-diverge-valcell" }, [
      h("span", { class: `fx-diverge-value ${signClass(value)}` }, [formatted]),
      h("span", { class: "fx-diverge-tag" }, [live ? "live" : "last"]),
    ]),
  ]);
}

/**
 * The two-leg diverging bar (market hours + overnight), or null when the split
 * can't be drawn (a missing live anchor leaves one leg null). The
 * currently-live leg leads: market hours while open, overnight once shut, with
 * the frozen "last" leg below. `format` adapts the leg values to EUR or USD.
 */
function fxDivergeBar(
  market: Decimal | null,
  overnight: Decimal | null,
  marketOpen: boolean,
  format: (v: Decimal) => string,
): HTMLElement | null {
  if (market === null || overnight === null || (market.isZero() && overnight.isZero())) {
    return null;
  }
  const maxMag = Decimal.max(market.abs(), overnight.abs());
  const widthOf = (v: Decimal): number =>
    maxMag.isZero() ? 0 : v.abs().dividedBy(maxMag).times(HALF_TRACK_PCT).toNumber();
  const mk = (label: string, value: Decimal, overnightLeg: boolean, live: boolean): HTMLElement =>
    fxDivergeRow({ label, value, formatted: format(value), overnightLeg, live, widthPct: widthOf(value) });
  const rows = marketOpen
    ? [mk("Market hours", market, false, true), mk("Overnight", overnight, true, false)]
    : [mk("Overnight", overnight, true, true), mk("Market hours", market, false, false)];
  return h("div", { class: "fx-diverge" }, rows);
}

/**
 * The currency panel inside {@link renderFxBox}. Its meaning depends on the
 * display currency:
 *
 *   - **EUR display** — the **"Currency effect since yesterday"** on the book.
 *     The book is USD-booked, so the EUR/USD move is only real money once
 *     measured back in euros (a rate move hands you no extra dollars). See
 *     {@link renderEurFxEffect}.
 *   - **USD display** — the **"Investing power since yesterday"**: how many more
 *     (+) or fewer (−) dollars the owner's configured regular investment amount
 *     (the euros they wire to the US to keep investing) buys now versus
 *     yesterday's close. A euro that strengthened means more bang for the buck.
 *     See {@link renderInvestingPowerEffect}.
 *
 * Both mirror the Python ``_fx_effect_html`` / ``_investing_power_html`` and
 * share the diverging market-hours/overnight bar. Returns null when there is no
 * move to describe.
 */
function renderFxEffect(o: OverviewView, now: Date = new Date()): HTMLElement | null {
  return getDisplayCurrency() === "USD"
    ? renderInvestingPowerEffect(o, now)
    : renderEurFxEffect(o, now);
}

/**
 * EUR display: the "Currency effect since yesterday" panel — the net EUR P/L
 * from today's EUR/USD move on the USD-booked book, with the diverging
 * market-hours/overnight split below.
 *
 * In the two **single-overnight** regimes there is no fresh session to split, so
 * one full-width bar carries the whole swing: a **US-only market holiday** (e.g.
 * 4th of July, FX still trading) keeps the "Market holiday" label, while the
 * **weekend spill-over** (Sunday evening through Monday's open) reads
 * "Overnight". The frozen Friday weekend keeps the full two-leg split, frozen.
 */
function renderEurFxEffect(o: OverviewView, now: Date): HTMLElement | null {
  const net = o.todayFxMoveEur;
  // No euro swing at all today ⇒ nothing worth a panel (the rate line still shows).
  if (net.isZero()) return null;

  const wrap = (kids: HTMLElement[]): HTMLElement =>
    h(
      "div",
      { class: "fx-effect", role: "group", "aria-label": "Currency effect since yesterday" },
      kids,
    );
  const children: HTMLElement[] = [
    h("div", { class: "fx-effect-head" }, [
      h("span", { class: "fx-effect-title" }, ["Currency effect since yesterday"]),
      h("span", { class: `fx-effect-net ${signClass(net)}` }, [formatSignedMoneyEur(net)]),
    ]),
  ];

  const { marketOpen, holiday, singleOvernight } = fxBoxRegime(now);
  if (singleOvernight) {
    children.push(
      h("div", { class: "fx-diverge" }, [
        fxDivergeRow({
          label: holiday ? "Market holiday" : "Overnight",
          value: net,
          formatted: formatSignedMoneyEur(net),
          overnightLeg: true,
          live: true,
          widthPct: HALF_TRACK_PCT,
        }),
      ]),
    );
    return wrap(children);
  }
  const split = fxEffectSplit({
    marketOpen,
    totalValueUsd: o.totalValueUsd,
    liveFx: o.fxRateEurUsd,
    sessionCloseFx: o.fxRateEurUsdSessionClose,
    sessionOpenFx: o.fxRateEurUsdSessionOpen,
    todayFxMoveEur: o.todayFxMoveEur,
  });
  const bar = fxDivergeBar(split.marketHoursEur, split.overnightEur, marketOpen, formatSignedMoneyEur);
  if (bar) children.push(bar);
  return wrap(children);
}

/**
 * USD display: the "Investing power since yesterday" panel. Instead of a
 * portfolio FX effect (which is exactly zero in dollars — the rate moving hands
 * you no extra dollars on assets already held), this answers a question the
 * owner actually cares about in USD: *with the euros I regularly wire over to
 * invest, do today's FX prices buy me more or fewer dollars than yesterday?*
 *
 * The figure is `amount · (liveFx − prevClose)` in USD, split into the same
 * market-hours/overnight legs as the EUR panel. It is rendered to *exactly
 * match* the EUR currency-effect visualization (headline + diverging bar, no
 * explanatory note) — only the basis differs. The one formatting twist: the
 * EUR panel shows whole units, but the investing-power swing is tiny (it rides
 * a regular contribution, not the whole book), so cents are restored whenever
 * the effect amount is two digits or less (|net| < $100) — otherwise it would
 * collapse to a meaningless "$0"/"$1". Returns null when there is no usable
 * rate pair or no swing to show.
 */
function renderInvestingPowerEffect(o: OverviewView, now: Date): HTMLElement | null {
  const fxNow = o.fxRateEurUsd;
  const fxPrev = o.fxRateEurUsdPrev;
  if (fxNow === null || fxPrev === null || !fxNow.greaterThan(0) || !fxPrev.greaterThan(0)) {
    return null;
  }
  const amountEur = getInvestmentAmountEur();
  const net = amountEur.times(fxNow.minus(fxPrev));
  if (net.isZero()) return null;

  // Whole dollars to mirror the EUR panel, but keep cents while the swing is two
  // digits or less so the (typically small) figure doesn't round away to "$0".
  const fractionDigits = net.abs().lessThan(100) ? 2 : 0;
  const fmt = (v: Decimal): string => formatSignedMoneyUsd(v, fractionDigits);

  const wrap = (kids: HTMLElement[]): HTMLElement =>
    h(
      "div",
      { class: "fx-effect", role: "group", "aria-label": "Investing power since yesterday" },
      kids,
    );
  const children: HTMLElement[] = [
    h("div", { class: "fx-effect-head" }, [
      h("span", { class: "fx-effect-title" }, ["Investing power since yesterday"]),
      h("span", { class: `fx-effect-net ${signClass(net)}` }, [fmt(net)]),
    ]),
  ];

  // Anchor the swing to the figures it rides: the regular EUR amount set in
  // Settings on the left, and the dollars it actually buys at today's live rate
  // on the right (amount · liveFx). Without this the headline is a delta with no
  // visible base; with it the owner sees both the euros they wire and the dollars
  // they would get today. Cents on the euro side only when the configured amount
  // isn't whole, so a clean "€100" doesn't read "€100.00".
  const amountDecimals = amountEur.isInteger() ? 0 : 2;
  const totalUsd = amountEur.times(fxNow);
  const amountRow = h("div", { class: "fx-effect-amount" }, [
    h("span", { class: "fx-effect-amount-label" }, [`Regular ${formatMoneyEur(amountEur, amountDecimals)}`]),
    h("span", { class: "fx-effect-amount-value" }, [`${formatMoneyUsd(totalUsd, 2)} today`]),
  ]);

  const { marketOpen, holiday, singleOvernight } = fxBoxRegime(now);
  if (singleOvernight) {
    children.push(
      h("div", { class: "fx-diverge" }, [
        fxDivergeRow({
          label: holiday ? "Market holiday" : "Overnight",
          value: net,
          formatted: fmt(net),
          overnightLeg: true,
          live: true,
          widthPct: HALF_TRACK_PCT,
        }),
      ]),
    );
    children.push(amountRow);
    return wrap(children);
  }
  const split = fxBuyingPowerSplit({
    marketOpen,
    amountEur,
    liveFx: fxNow,
    prevFx: fxPrev,
    sessionCloseFx: o.fxRateEurUsdSessionClose,
    sessionOpenFx: o.fxRateEurUsdSessionOpen,
  });
  const bar = fxDivergeBar(split.marketHoursUsd, split.overnightUsd, marketOpen, fmt);
  if (bar) children.push(bar);
  children.push(amountRow);
  return wrap(children);
}

/** One return horizon (Today / This month / This year). */
function segment(label: string, value: Decimal | null): HTMLElement {
  return h("div", { class: "segment-item" }, [
    h("span", { class: "segment-label" }, [label]),
    h("span", { class: `segment-value ${signClass(value)}` }, [signedPercentOrDash(value)]),
  ]);
}

/** Today / month / year return horizons, side by side. */
function renderReturns(o: OverviewView, now: Date = new Date()): HTMLElement {
  return h("section", { class: "segment", "aria-label": "Return by period" }, [
    // The first horizon names the same session the hero's move does, so the
    // app never reads "Today" here while the hero reads "Yesterday" above it.
    segment(sessionMoveLabel(now), pickByCurrency(o.todayMovePct, o.todayMovePctUsd)),
    segment("This month", pickByCurrency(o.mtdGrowthPct, o.mtdGrowthPctUsd)),
    segment("This year", pickByCurrency(o.ytdGrowthPct, o.ytdGrowthPctUsd)),
  ]);
}

function stat(label: string, value: string, cls = "flat", sub?: string): HTMLElement {
  const children: Array<Node | string> = [
    h("span", { class: "stat-label" }, [label]),
    h("span", { class: `stat-value ${cls}` }, [value]),
  ];
  if (sub) children.push(h("span", { class: `stat-sub ${cls}` }, [sub]));
  return h("div", { class: "stat" }, children);
}

/** Compact KPI grid — parity-matched to the desktop overview headline. */
function renderStats(o: OverviewView): HTMLElement {
  // Growth figures are currency-dependent: prefer the USD figure when USD is
  // selected (FX drift between the cash-flow dates and now makes EUR and USD
  // growth genuinely differ), mirroring the desktop's per-currency KPIs.
  const totalGrowthCompounded = pickByCurrency(
    o.totalGrowthCompoundedPct,
    o.totalGrowthCompoundedPctUsd,
  );
  const xirr = pickByCurrency(o.portfolioXirr, o.portfolioXirrUsd);
  const gainPicked = pickByCurrency(o.totalGainEur, o.totalGainUsd);
  const grid = h("div", { class: "stat-grid" }, [
    // Total gain is the capital gain (mirrors the desktop): value + cash
    // dividends − net contributions. The compounded growth % sits right beside
    // it, so the gain stat shows the money figure alone — no redundant percent.
    stat(
      "Total gain",
      formatSignedDualCurrency(o.totalGainEur, o.totalGainUsd),
      signClass(gainPicked),
    ),
    stat(
      "Total growth",
      signedPercentOrDash(totalGrowthCompounded),
      signClass(totalGrowthCompounded),
    ),
    stat("XIRR", formatPercent(xirr), signClass(xirr)),
    stat("Div. return", o.dividendYieldPct !== null ? formatPercent(o.dividendYieldPct) : "—"),
    stat("Invested", formatDualCurrency(o.totalCostBasisEur, o.totalCostBasisUsd)),
    stat("Dividends YTD", formatCurrency(o.totalDividendsEur)),
  ]);
  return h("section", { class: "stats" }, [grid, ...renderNotes(o)]);
}

function renderNotes(o: OverviewView): HTMLElement[] {
  const notes: HTMLElement[] = [];
  // Lead with the live-coverage line: a calm, descriptive "how much is fresh"
  // status.
  const coverageParts: string[] = [];
  if (o.liveCoverage) coverageParts.push(o.liveCoverage);
  if (coverageParts.length > 0) {
    notes.push(h("p", { class: "note coverage" }, [coverageParts.join(" · ")]));
  }
  if (o.liveDegradedReason) {
    notes.push(h("p", { class: "note warn" }, [o.liveDegradedReason]));
  }
  if (o.missingPriceSymbols.length > 0) {
    notes.push(
      h("p", { class: "note warn" }, [
        `No live price or last-known value for ${o.missingPriceSymbols.join(", ")}, so they are excluded from totals.`,
      ]),
    );
  }
  if (o.staleValueSymbols.length > 0) {
    notes.push(
      h("p", { class: "note" }, [
        `Using the last exported value for ${o.staleValueSymbols.join(", ")} (no live price available).`,
      ]),
    );
  }
  if (o.fxMissingCurrencies.length > 0) {
    notes.push(
      h("p", { class: "note warn" }, [
        `Missing FX rate for ${o.fxMissingCurrencies.join(", ")}; those holdings are excluded from totals.`,
      ]),
    );
  }
  notes.push(
    h("p", { class: "note" }, [
      `Exported ${formatExportedAt(o.generatedAt)} · last pulled ${formatLastPull(o.lastDataPullAt)}.`,
    ]),
  );
  if (o.dailyCreditsUsed !== null) {
    notes.push(
      h("p", { class: "note" }, [
        `Live budget today: ${o.dailyCreditsUsed} / ${o.dailyCreditLimit}.`,
      ]),
    );
  }
  if (o.tiingoDayUsed !== null && o.tiingoHourUsed !== null) {
    notes.push(
      h("p", { class: "note" }, [
        `Fallback budget: ${o.tiingoHourUsed} / ${o.tiingoHourLimit} this hour · ` +
          `${o.tiingoDayUsed} / ${o.tiingoDayLimit} today.`,
      ]),
    );
  }
  return notes;
}

/**
 * Allocation by asset class — de-emphasised into a collapsed `<details>` panel
 * below the holdings. For a fixed, lopsided allocation this keeps it one tap
 * away without competing with the headline value and KPIs above.
 */
function renderAllocation(allocation: AllocationSlice[]): HTMLElement | null {
  if (allocation.length === 0) return null;
  const rows = allocation.map((slice, index) => {
    const pct = slice.weight !== null ? slice.weight.times(100).toNumber() : 0;
    const bar = h("span", { class: "alloc-bar" }, [
      h("span", { class: `alloc-bar-fill tone-${index % 5}`, style: `width:${pct.toFixed(1)}%` }, []),
    ]);
    return h("li", { class: "alloc-row" }, [
      h("div", { class: "alloc-head" }, [
        h("span", { class: "alloc-label" }, [titleCase(slice.label)]),
        h("span", { class: "alloc-pct" }, [slice.weight !== null ? formatPercent(slice.weight) : "—"]),
      ]),
      bar,
      h("span", { class: "alloc-value muted" }, [formatCurrency(slice.valueEur)]),
    ]);
  });
  const id = "allocation";
  const attrs: Attrs = { class: "allocation" };
  if (loadOpenState(id, false)) attrs.open = "open";
  const details = h("details", attrs, [
    h("summary", { class: "alloc-summary" }, [
      h("span", { class: "alloc-summary-title" }, ["Allocation"]),
      h("span", { class: "muted" }, ["by asset class"]),
    ]),
    h("ul", { class: "alloc-list" }, rows),
  ]) as HTMLDetailsElement;
  details.addEventListener("toggle", () => saveOpenState(id, details.open));
  return details;
}

/** Humanise an asset-class slug ("money_market" → "Money Market"). */
function titleCase(label: string): string {
  return label
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function chip(text: string, cls = ""): HTMLElement {
  return h("span", { class: `chip ${cls}`.trim() }, [text]);
}

/**
 * A collapsible section: a tappable header (title + optional sub-label and a
 * chevron) over a body that can be folded away. Long lists (holdings, the
 * by-month and by-year period tables) use this so the user can collapse a list
 * and reach the content below it without scrolling past every row — important
 * on a phone where these lists can run long. Open by default unless told not to.
 *
 * Each section's open/closed state is remembered per device (keyed by its
 * stable class/title), so collapsing a list to reach what's beneath it survives
 * a refresh, a currency toggle, or a return from Settings.
 */
function collapsibleSection(
  title: string,
  sub: string | undefined,
  body: HTMLElement,
  extraClass = "",
  open = true,
): HTMLElement {
  const summaryChildren: Array<Node | string> = [h("h2", {}, [title])];
  if (sub) summaryChildren.push(h("span", { class: "muted" }, [sub]));
  // Combine the (stable) class and title so each section gets a distinct,
  // collision-proof persistence key.
  const id = `${extraClass} ${title}`.trim().replace(/\s+/g, "-").toLowerCase();
  const attrs: Attrs = { class: `collapsible ${extraClass}`.trim() };
  if (loadOpenState(id, open)) attrs.open = "open";
  const details = h("details", attrs, [
    h("summary", { class: "collapsible-summary" }, summaryChildren),
    body,
  ]) as HTMLDetailsElement;
  details.addEventListener("toggle", () => saveOpenState(id, details.open));
  return details;
}

const COLLAPSE_KEY_PREFIX = "iv.web.collapse.";

/** Read a section's remembered open state, defaulting to `fallbackOpen`. */
function loadOpenState(id: string, fallbackOpen: boolean): boolean {
  try {
    const value = localStorage.getItem(COLLAPSE_KEY_PREFIX + id);
    if (value === "open") return true;
    if (value === "closed") return false;
  } catch {
    /* No storage access; fall back to the default open state. */
  }
  return fallbackOpen;
}

/** Persist a section's open state so it survives a re-render or refresh. */
function saveOpenState(id: string, open: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY_PREFIX + id, open ? "open" : "closed");
  } catch {
    /* Preference just won't persist; the in-memory state still applies. */
  }
}

/** Read a persisted boolean flag, defaulting to `fallback` when unset/unreadable. */
function loadBoolPref(key: string, fallback = false): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    /* No storage access; fall back to the default. */
  }
  return fallback;
}

/** Persist a boolean flag so it survives a refresh (mirrors the desktop prefs). */
function saveBoolPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* Preference just won't persist; the in-memory state still applies. */
  }
}

/**
 * Read a persisted free-form string selection (e.g. a chart timeframe or a
 * segmented toggle's active option), returning `null` when unset/unreadable.
 * Used so a selection survives the full re-render the currency toggle triggers.
 */
function loadStringPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist a free-form string selection so it survives a re-render or refresh. */
function saveStringPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preference just won't persist; the in-memory selection still applies. */
  }
}

/** Persisted calculator toggle keys (parity with the desktop's `calc.*` prefs). */
const CALC_FRACTIONAL_KEY = "iv.web.calc.allowFractional";
const CALC_REBALANCE_KEY = "iv.web.calc.rebalance";
/** Allocation-calculator (calc2) remembered selections: target mode + cash. */
const CALC2_MODE_KEY = "iv.web.calc2.mode";
const CALC2_CASH_EUR_KEY = "iv.web.calc2.cashEur";

/**
 * Persisted projection-calculator field keys. Money fields (contribution,
 * target) are stored in EUR so the persisted value is currency-neutral and
 * re-seeds correctly into whichever display currency is active after a toggle.
 */
const PROJ_KEYS = {
  monthly: "iv.web.proj.monthly",
  real: "iv.web.proj.real",
  rate: "iv.web.proj.rate",
  band: "iv.web.proj.band",
  stepUp: "iv.web.proj.stepUp",
  inflation: "iv.web.proj.inflation",
  horizon: "iv.web.proj.horizon",
  contribEur: "iv.web.proj.contribEur",
  targetEur: "iv.web.proj.targetEur",
} as const;

/** A single holding as a list row (mobile-first, no wide horizontal table). */
function renderHoldingRow(holding: HoldingView, badge?: string, now: Date = new Date()): HTMLElement {
  const symChildren: Array<Node | string> = [holding.symbol];
  if (holding.priceType === "nav") symChildren.push(h("span", { class: "pill" }, ["NAV"]));
  // A genuinely stale fallback (no price at all) is still flagged; the milder
  // "price came from the export" case is conveyed by the "as of" date/time below
  // rather than a vague "last known" bubble.
  if (holding.valueIsStale) {
    symChildren.push(h("span", { class: "pill stale" }, ["stale value"]));
  }
  // A movers badge reminds the viewer this row topped today's leaderboard.
  if (badge) {
    const badgeCls = badge.includes("loser") ? "neg" : "pos";
    symChildren.push(h("span", { class: `mover-badge ${badgeCls}` }, [badge]));
  }

  const todayPct = pickByCurrency(holding.todayMovePct, holding.todayMovePctUsd);
  const todayCls = signClass(todayPct);
  // A holding still on an older print than its peers shows last session's move,
  // not today's — grey it so a live glance separates today's numbers from the
  // ones yet to refresh. Before the open nothing is stale, so nothing greys.
  const todayStaleCls = holding.todayMoveIsStale ? " holding-change-stale" : "";
  // The same session word the hero/returns use, so a stale row's tooltip names
  // the session everyone else is on rather than a hard-coded "today".
  const moveWord = sessionMoveWord(now);
  const main = h("div", { class: "holding-main" }, [
    h("div", { class: "holding-id" }, [
      // Top line: symbol (+ NAV/stale pills) on the left, and the price's
      // "as of" date pushed to the right — into the gap between the pills and
      // the value — so a stale-but-latest NAV reads honestly there (e.g. "as of
      // 20 Jun") instead of being buried on a line under the name.
      h("div", { class: "holding-topline" }, [
        h("span", { class: "holding-sym" }, symChildren),
        h("span", { class: "holding-asof" }, [
          `as of ${formatAsOf(holding.priceAsOf, holding.priceFallbackDate)}`,
        ]),
      ]),
      h("span", { class: "holding-name" }, [holding.name]),
    ]),
    h("div", { class: "holding-figures" }, [
      h("span", { class: "holding-value" }, [formatCurrency(holding.valueEur)]),
      h("span", {
        class: `holding-change ${todayCls}${todayStaleCls}`,
        ...(holding.todayMoveIsStale ? { title: `Not updated ${moveWord} — an earlier session's move` } : {}),
      }, [signedPercentOrDash(todayPct)]),
    ]),
  ]);

  const growthPct = pickByCurrency(holding.totalGrowthPct, holding.totalGrowthPctUsd);
  const plPicked = pickByCurrency(holding.unrealisedPlEur, holding.unrealisedPlUsd);
  const holdingXirr = pickByCurrency(holding.xirr, holding.xirrUsd);
  const meta = h("div", { class: "holding-meta" }, [
    chip(
      holding.priceNative !== null
        ? `Px ${formatNativePrice(holding.priceNative, holding.nativeCurrency)}`
        : "Px —",
    ),
    chip(`${formatShares(holding.shares)} sh`),
    // Weight (% of portfolio) is a secondary stat — it now lives in the desktop
    // Holdings table. The card instead leads with total growth on cost, the
    // headline performance figure, coloured by sign.
    chip(
      growthPct !== null ? `${formatSignedPercent(growthPct)} growth` : "— growth",
      signClass(growthPct),
    ),
    chip(
      `P/L ${formatSignedDualCurrency(holding.unrealisedPlEur, holding.unrealisedPlUsd)}`,
      signClass(plPicked),
    ),
    chip(`XIRR ${formatPercent(holdingXirr)}`, signClass(holdingXirr)),
  ]);

  return h("li", { class: "holding" }, [main, meta]);
}

function renderHoldings(holdings: HoldingView[], badges?: Map<string, string>, now: Date = new Date()): HTMLElement {
  const sorted = [...holdings].sort((a, b) => {
    const av = a.valueEur?.toNumber() ?? -1;
    const bv = b.valueEur?.toNumber() ?? -1;
    return bv - av;
  });
  const count = `${holdings.length} ${holdings.length === 1 ? "position" : "positions"}`;
  const list = h(
    "ul",
    { class: "holding-list" },
    sorted.map((holding) => renderHoldingRow(holding, badges?.get(holding.symbol), now)),
  );
  return collapsibleSection("Holdings", count, list, "holdings");
}

/** A short "20 Jun" / "Today" label for the movers basis date (ISO `YYYY-MM-DD`). */
function moversBasisLabel(basisDate: string | null, now: Date = new Date()): string {
  if (basisDate === null) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(basisDate);
  if (match === null) return basisDate;
  const [, year, month, day] = match;
  // Compare as local calendar dates so "today" reflects the viewer's day.
  const isToday =
    Number(year) === now.getFullYear() &&
    Number(month) === now.getMonth() + 1 &&
    Number(day) === now.getDate();
  if (isToday) return "today";
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** One winner/loser block: the stat it ranked on shown large on top. */
function renderMoverBlock(entry: MoverEntry, side: "winner" | "loser"): HTMLElement {
  const pct = pickByCurrency(entry.todayMovePct, entry.todayMovePctUsd);
  const money = formatSignedDualCurrency(entry.todayMoveEur, entry.todayMoveUsd);
  const cls = side === "winner" ? "pos" : "neg";
  const tag = entry.reason === "total" ? "biggest move" : "top %";
  // The figure it earned its slot on leads (large, on top); the other trails.
  const primary = entry.reason === "total" ? money : signedPercentOrDash(pct);
  const secondary = entry.reason === "total" ? signedPercentOrDash(pct) : money;
  const sideLabel = side === "winner" ? "Winner" : "Loser";
  return h("div", { class: `mover-block ${cls}` }, [
    h("div", { class: "mover-head" }, [
      h("span", { class: "mover-side" }, [sideLabel]),
      h("span", { class: "mover-tag" }, [tag]),
    ]),
    h("div", { class: "mover-id" }, [
      h("span", { class: "mover-sym" }, [entry.symbol]),
      h("span", { class: "mover-name", title: entry.name }, [entry.name]),
    ]),
    h("div", { class: "mover-figures" }, [
      h("span", { class: `mover-primary ${cls}` }, [primary]),
      h("span", { class: "mover-secondary" }, [secondary]),
    ]),
  ]);
}

/**
 * Today's winners & losers as a distinct "special notice" band: up to four
 * blocks across (two winners, two losers) on wide screens, each leading with the
 * stat it was ranked on (money or %, large on top). Ranked in the active display
 * currency so the board agrees with the figures on screen and with the desktop
 * app. Measured on the freshest price date across the book, so before the open
 * it reflects last session and during the session only what has already printed
 * today. Hidden entirely when nothing has a today's move yet.
 */
function renderMovers(holdings: HoldingView[]): HTMLElement | null {
  const movers = buildMovers(holdings, getDisplayCurrency());
  if (movers.winners.length === 0 && movers.losers.length === 0) return null;
  const basis = moversBasisLabel(movers.basisDate);
  const sub = basis === "today" ? "today" : `last close · ${basis}`;
  const blocks = [
    ...movers.winners.map((e) => renderMoverBlock(e, "winner")),
    ...movers.losers.map((e) => renderMoverBlock(e, "loser")),
  ];
  const grid = h("div", { class: "mover-grid" }, blocks);
  const section = collapsibleSection("Top movers", sub, grid, "movers");
  section.classList.add("movers-band");
  return section;
}

/**
 * Map each leaderboard holding to a short badge label (e.g. "Top gainer"), so
 * the holdings list can remind the viewer why a row stood out today. Built from
 * the same currency-aware leaderboard the band shows.
 */
function moverBadges(holdings: HoldingView[]): Map<string, string> {
  const movers = buildMovers(holdings, getDisplayCurrency());
  const badges = new Map<string, string>();
  for (const e of movers.winners) {
    badges.set(e.symbol, e.reason === "total" ? "Top gainer" : "Top % gainer");
  }
  for (const e of movers.losers) {
    badges.set(e.symbol, e.reason === "total" ? "Top loser" : "Top % loser");
  }
  return badges;
}

export function renderDashboard(
  model: DashboardModel,
  onRefresh: () => void,
  onLock: () => void,
  onToggleCurrency: () => void,
  onSettings: () => void,
  lockLabel = "Lock",
  liveGraph?: LiveGraphHooks,
  options: { initialTabId?: string } = {},
): HTMLElement {
  const refresh = h("button", { class: "icon-btn", type: "button", "data-action": "refresh" }, [
    h("span", { class: "icon-btn-glyph", "aria-hidden": "true" }, ["↻"]),
    h("span", { class: "icon-btn-text" }, ["Refresh"]),
  ]);
  refresh.title = `Last updated ${formatLastPull(model.overview.lastDataPullAt)}`;
  const lock = h("button", { class: "icon-btn ghost", type: "button", "data-action": "lock" }, [lockLabel]);
  refresh.addEventListener("click", onRefresh);
  lock.addEventListener("click", onLock);

  const settings = h(
    "button",
    { class: "icon-btn ghost icon-only", type: "button", "data-action": "settings", "aria-label": "Settings", title: "Settings" },
    [h("span", { class: "icon-btn-glyph", "aria-hidden": "true" }, ["⚙"])],
  );
  settings.addEventListener("click", onSettings);

  const currency = renderCurrencyToggle(onToggleCurrency);

  const topbar = h("header", { class: "topbar" }, [
    h("div", { class: "topbar-inner" }, [
      h("div", { class: "brand" }, [
        h("span", { class: "brand-mark", "aria-hidden": "true" }, []),
        h("span", { class: "brand-name" }, ["Investment Overview"]),
        h("span", { class: "brand-version", title: `Web app version ${APP_VERSION}` }, [`v${APP_VERSION}`]),
      ]),
      h("div", { class: "topbar-actions" }, [currency, refresh, settings, lock]),
    ]),
  ]);

  // Each tab is a self-contained panel; the nav just toggles which is visible
  // (no re-render, so live figures and form state survive a tab switch).
  const tabs: TabDef[] = [
    { id: "overview", label: "Overview", glyph: "◎", panel: renderOverviewPanel(model, liveGraph) },
    { id: "periods", label: "Periods", glyph: "▦", panel: renderPeriodsPanel(model.periods, model.deposits, model.plan) },
    { id: "analytics", label: "Risk", glyph: "📈", panel: renderAnalyticsPanel(model.analytics, model.overview, model.deposits) },
    { id: "plan", label: "Calculator", glyph: "🧮", panel: renderCalculatorPanel(model.calculator) },
  ];

  const { nav, content } = renderTabs(tabs, options.initialTabId);
  return h("main", { class: "app" }, [topbar, nav, content]);
}

interface TabDef {
  id: string;
  label: string;
  glyph: string;
  panel: HTMLElement;
}

/**
 * A tab bar + the stacked panels. Mobile-first: the bar is a fixed,
 * thumb-reachable bottom navigation; on wide screens CSS reflows it to sit
 * directly beneath the topbar (see styles.css). Switching is purely visual.
 */
function renderTabs(tabs: TabDef[], initialTabId?: string): { nav: HTMLElement; content: HTMLElement } {
  const buttons: HTMLButtonElement[] = [];
  const panels = tabs.map((tab) => {
    tab.panel.classList.add("tab-panel");
    tab.panel.id = `panel-${tab.id}`;
    tab.panel.setAttribute("role", "tabpanel");
    return tab.panel;
  });

  const select = (index: number, persist = true): void => {
    tabs.forEach((_, i) => {
      const active = i === index;
      buttons[i].classList.toggle("active", active);
      buttons[i].setAttribute("aria-selected", active ? "true" : "false");
      panels[i].hidden = !active;
    });
    if (persist) saveActiveTab(tabs[index]?.id);
  };

  tabs.forEach((tab, index) => {
    const button = h(
      "button",
      { class: "tab", type: "button", role: "tab", id: `tab-${tab.id}`, "aria-controls": `panel-${tab.id}` },
      [
        h("span", { class: "tab-glyph", "aria-hidden": "true" }, [tab.glyph]),
        h("span", { class: "tab-label" }, [tab.label]),
      ],
    ) as HTMLButtonElement;
    button.addEventListener("click", () => select(index));
    buttons.push(button);
  });

  const nav = h("nav", { class: "tabbar", "aria-label": "Sections" }, buttons);
  const content = h("div", { class: "content" }, panels);
  // Reopen the section the user last viewed (e.g. across a refresh or currency
  // toggle re-render); default to the first tab when none is remembered. A
  // caller-supplied `initialTabId` (deep link) wins and is applied without
  // persisting, so it never overwrites the user's remembered tab.
  if (initialTabId) {
    const deepIndex = tabs.findIndex((t) => t.id === initialTabId);
    if (deepIndex >= 0) {
      select(deepIndex, false);
      return { nav, content };
    }
  }
  const savedIndex = tabs.findIndex((t) => t.id === loadActiveTab());
  select(savedIndex >= 0 ? savedIndex : 0, false);
  return { nav, content };
}

const ACTIVE_TAB_KEY = "iv.web.tab";

function loadActiveTab(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TAB_KEY);
  } catch {
    return null;
  }
}

function saveActiveTab(id: string | undefined): void {
  if (!id) return;
  try {
    localStorage.setItem(ACTIVE_TAB_KEY, id);
  } catch {
    /* Preference just won't persist; the in-memory selection still applies. */
  }
}

/** The Phase 3 overview (hero, return horizons, KPIs, holdings, allocation). */
function renderOverviewPanel(model: DashboardModel, liveGraph?: LiveGraphHooks): HTMLElement {
  const content: Array<Node | string> = [
    renderHero(model.overview),
    renderReturns(model.overview),
  ];
  const fxBox = renderFxBox(model.overview);
  if (fxBox) content.push(fxBox);
  // Today's winners/losers sit as a distinct band below the value chart and the
  // stats block whose notes explain how fresh the data is ("data last pulled…",
  // live coverage, budget) — so the leaderboard reads right after the graph and
  // the update text that frame it, mirroring the desktop layout. The badges
  // below still tie each mover back to its holding row.
  const valueChart = renderValueChart(model.analytics, model.overview, liveGraph, model.valueBackfill);
  if (valueChart) content.push(valueChart);
  content.push(renderStats(model.overview));
  const movers = renderMovers(model.holdings);
  if (movers) content.push(movers);
  content.push(renderHoldings(model.holdings, moverBadges(model.holdings)));
  const allocation = renderAllocation(model.allocation);
  if (allocation) content.push(allocation);
  content.push(
    h("p", { class: "disclaimer" }, [
      "Read-only. Live figures are computed in your browser from public market data and may differ slightly from your broker.",
    ]),
  );
  return h("section", { class: "panel-overview", "aria-labelledby": "tab-overview" }, content);
}

// --- Periods tab ------------------------------------------------------------

function sectionHead(title: string, sub?: string): HTMLElement {
  const children: Array<Node | string> = [h("h2", {}, [title])];
  if (sub) children.push(h("span", { class: "muted" }, [sub]));
  return h("div", { class: "section-head" }, children);
}

/** Humanise a `YYYY-MM` period label into e.g. "Jun 2026"; years pass through. */
function periodLabel(label: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) return label;
  const month = Number(match[2]) - 1;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[month] ?? match[2]} ${match[1]}`;
}

function renderPeriodRow(row: PeriodRowView): HTMLElement {
  // Period growth is currency-dependent (FX drift between the period boundary
  // and now), so prefer the USD figure when USD is selected — matching the
  // per-stock and headline growth — rather than showing the EUR number twice.
  const growthPct = pickByCurrency(row.growthPct, row.growthPctUsd);
  const growthCls = signClass(growthPct);
  const badges: Array<Node | string> = [periodLabel(row.label)];
  if (row.isLive) badges.push(h("span", { class: "pill live" }, ["live"]));
  else if (row.isCurrent) badges.push(h("span", { class: "pill" }, ["current"]));

  const main = h("div", { class: "holding-main" }, [
    h("div", { class: "holding-id" }, [
      h("span", { class: "holding-sym" }, badges),
      h("span", { class: "holding-name" }, [
        row.closingValueEur !== null
          ? `Value ${formatDualCurrency(row.closingValueEur, row.closingValueUsd)}`
          : "Value —",
      ]),
    ]),
    h("div", { class: "holding-figures" }, [
      h("span", { class: `holding-value ${growthCls}` }, [signedPercentOrDash(growthPct)]),
      h("span", { class: "holding-change muted" }, ["growth"]),
    ]),
  ]);

  const meta = h("div", { class: "holding-meta" }, [
    chip(`Net flow ${formatSignedDualCurrency(row.netFlowEur, row.netFlowUsd)}`, signClass(row.netFlowEur)),
    chip(`Contrib ${formatDualCurrency(row.contributionsEur, row.contributionsUsd)}`),
    chip(`Div ${formatDualCurrency(row.dividendsEur, row.dividendsUsd)}`),
    chip(`Int ${formatDualCurrency(row.interestEur, row.interestUsd)}`),
  ]);

  return h("li", { class: "holding" }, [main, meta]);
}

/**
 * Contributions panel for the Periods tab's right column. Collapsible: a headline
 * stat triplet (total / this year / this month) stays visible in the summary,
 * and unfolding reveals the full contribution ledger grouped per year (each year
 * independently expandable, "like before").
 */
function renderContributions(deposits: DepositsView): HTMLElement {
  const ZERO = new Decimal(0);
  // Show each contribution KPI in both currencies (the active one large, the
  // other as a smaller sub-line) — currency drift between the cash-flow dates and
  // now is exactly what's interesting here, so it's surfaced without toggling.
  const dualStat = (label: string, eur: Decimal | null, usd: Decimal | null): HTMLElement => {
    const parts = formatDualCurrencyParts(eur, usd);
    if (parts === null) return stat(label, "—");
    return stat(label, parts.primary, "flat", parts.secondary ?? undefined);
  };
  const statGrid = h("div", { class: "stat-grid" }, [
    dualStat("Contributed", deposits.totalEur, deposits.totalUsd),
    dualStat("This year", deposits.ytdEur, deposits.ytdUsd),
    dualStat("This month", deposits.mtdEur, deposits.mtdUsd),
  ]);

  // Group the ledger rows by calendar year (newest first) so each year folds
  // away on its own — the contribution history can run long.
  const byYear = new Map<string, DepositRowView[]>();
  for (const row of deposits.rows) {
    const yr = row.date.slice(0, 4);
    const bucket = byYear.get(yr);
    if (bucket) bucket.push(row);
    else byYear.set(yr, [row]);
  }
  const yearBlocks = Array.from(byYear.keys())
    .sort()
    .reverse()
    .map((yr) => {
      const rows = byYear.get(yr) ?? [];
      // Sum the year's flows in both currencies (each USD leg already at its own
      // trade-date FX) so the folded summary shows how *much* was contributed,
      // not just how many times.
      let yearEur: Decimal | null = null;
      let yearUsd: Decimal | null = null;
      for (const r of rows) {
        if (r.amountEur !== null) yearEur = (yearEur ?? ZERO).plus(r.amountEur);
        if (r.amountUsd !== null) yearUsd = (yearUsd ?? ZERO).plus(r.amountUsd);
      }
      const id = `deposits-year-${yr}`;
      const attrs: Attrs = { class: "allocation year-contribs" };
      if (loadOpenState(id, false)) attrs.open = "open";
      const details = h("details", attrs, [
        h("summary", { class: "alloc-summary year-contribs-summary" }, [
          h("span", { class: "year-contribs-head" }, [
            h("span", { class: "alloc-summary-title" }, [yr]),
            h("span", { class: "year-contribs-count muted" }, [
              `${rows.length} contribution${rows.length === 1 ? "" : "s"}`,
            ]),
          ]),
          h("span", { class: "year-contribs-meta muted" }, [dualAmount(yearEur, yearUsd)]),
        ]),
        h("ul", { class: "ledger-list" }, rows.map(renderDepositRow)),
      ]) as HTMLDetailsElement;
      details.addEventListener("toggle", () => saveOpenState(id, details.open));
      return details;
    });

  const body = h("div", { class: "contributions-body" }, [
    h("div", { class: "stats" }, [statGrid]),
    ...(yearBlocks.length > 0 ? yearBlocks : [h("p", { class: "note" }, ["No contributions yet."])]),
  ]);

  const sub = deposits.totalEur !== null
    ? formatDualCurrency(deposits.totalEur, deposits.totalUsd)
    : undefined;
  return collapsibleSection("Contributions", sub, body, "deposits", true);
}

/**
 * The Periods tab's projection block: the calculator's settings window (copied
 * from the Calculator tab and made fully independent via {@link buildCalculator})
 * stacked above the projection outputs it drives. Both halves are independently
 * collapsible; the projection's collapsed summary tracks the live "Expected"
 * horizon value so it stays informative when folded. Returns two sections
 * (settings, then projection) for the right column.
 */
function renderPeriodsProjection(plan: PlanView): HTMLElement[] {
  // A mutable sub-label element so recompute() can refresh the projection's
  // collapsed summary in place.
  const projSub = h("span", { class: "muted" }, ["forward outlook"]);

  const { form, kpiOut, goalOut, tableOut } = buildCalculator(plan, {
    headless: true,
    onSummary: (text) => {
      projSub.textContent = text;
    },
  });

  const settings = collapsibleSection(
    "Projection settings",
    "assumptions",
    h("div", { class: "periods-calc-settings-body" }, [form]),
    "periods-calc-settings",
    false,
  );

  const projectionBody = h("div", { class: "periods-projection-body" }, [kpiOut, goalOut, tableOut]);
  // Build the projection collapsible by hand (rather than collapsibleSection) so
  // the summary can carry the live `projSub` element instead of a static string.
  const id = "periods-projection";
  const attrs: Attrs = { class: "collapsible periods-projection" };
  if (loadOpenState(id, true)) attrs.open = "open";
  const projection = h("details", attrs, [
    h("summary", { class: "collapsible-summary" }, [h("h2", {}, ["Projection"]), projSub]),
    projectionBody,
  ]) as HTMLDetailsElement;
  projection.addEventListener("toggle", () => saveOpenState(id, projection.open));

  return [settings, projection];
}


/** One contribution ledger row, used nested under its year group. */
function renderDepositRow(row: DepositRowView): HTMLElement {
  return h("li", { class: "ledger-row" }, [
    h("div", { class: "ledger-id" }, [
      h("span", { class: "ledger-kind" }, [titleCase(row.kind)]),
      h("span", { class: "ledger-sub muted" }, [`${row.date} · ${row.account}`]),
    ]),
    dualAmount(row.amountEur, row.amountUsd),
  ]);
}

/**
 * A money amount shown in both currencies at once — the active display currency
 * large, the other smaller beneath it — so currency drift on a contribution is
 * visible without toggling. Each leg uses its own per-trade-date-FX value (see
 * {@link formatDualCurrencyParts}). Falls back to a single figure when only one
 * currency can be priced.
 */
function dualAmount(amountEur: Decimal | null, amountUsd: Decimal | null): HTMLElement {
  const parts: DualCurrencyParts | null = formatDualCurrencyParts(amountEur, amountUsd);
  if (parts === null) return h("span", { class: "ledger-amount" }, ["—"]);
  const children: Array<Node | string> = [h("span", { class: "dual-amount-primary" }, [parts.primary])];
  if (parts.secondary !== null) {
    children.push(h("span", { class: "dual-amount-secondary muted" }, [parts.secondary]));
  }
  return h("span", { class: "ledger-amount dual-amount" }, children);
}

/**
 * A single collapsible year group for the Periods tab's left column: the folded
 * monthly overview for one year. The year's stat tiles (net flow, contributions,
 * dividends, interest) and its headline (growth % + closing value) stay visible
 * in the always-shown summary even when collapsed; unfolding reveals the months.
 * The current year defaults open; prior years stay condensed until tapped.
 */
function renderYearGroup(
  year: string,
  yearRow: PeriodRowView | undefined,
  months: PeriodRowView[],
  isCurrent: boolean,
): HTMLElement {
  // Headline: growth % and closing value, pushed to the right of the summary
  // (right-aligned, with space after the year) and given a touch more emphasis
  // than the muted sub-labels elsewhere.
  const growthPct = yearRow ? pickByCurrency(yearRow.growthPct, yearRow.growthPctUsd) : null;
  const valuePart =
    yearRow && yearRow.closingValueEur !== null
      ? formatDualCurrency(yearRow.closingValueEur, yearRow.closingValueUsd)
      : "—";
  const headline = h("div", { class: "year-headline" }, [
    h("span", { class: "year-value" }, [valuePart]),
    h("span", { class: `year-growth ${signClass(growthPct)}` }, [signedPercentOrDash(growthPct)]),
  ]);

  const titleRow = h("div", { class: "year-title-row" }, [
    h("h2", {}, [year]),
    ...(isCurrent ? [h("span", { class: "pill" }, ["current"])] : []),
    headline,
  ]);

  const summaryChildren: Array<Node | string> = [titleRow];
  if (yearRow) {
    // The year's own flows/dividends/interest as a compact meta strip — kept in
    // the summary so the tiles show even when the year is folded together.
    summaryChildren.push(
      h("div", { class: "holding-meta year-meta" }, [
        chip(`Net flow ${formatSignedDualCurrency(yearRow.netFlowEur, yearRow.netFlowUsd)}`, signClass(yearRow.netFlowEur)),
        chip(`Contrib ${formatDualCurrency(yearRow.contributionsEur, yearRow.contributionsUsd)}`),
        chip(`Div ${formatDualCurrency(yearRow.dividendsEur, yearRow.dividendsUsd)}`),
        chip(`Int ${formatDualCurrency(yearRow.interestEur, yearRow.interestUsd)}`),
      ]),
    );
  }

  const body =
    months.length > 0
      ? h("ul", { class: "holding-list" }, months.map(renderPeriodRow))
      : h("p", { class: "note" }, ["No monthly breakdown for this year."]);

  const id = `periods-year-${year}`;
  const attrs: Attrs = { class: "collapsible periods-year" };
  if (loadOpenState(id, isCurrent)) attrs.open = "open";
  const details = h("details", attrs, [
    h("summary", { class: "collapsible-summary year-summary" }, summaryChildren),
    h("div", { class: "year-group-body" }, [body]),
  ]) as HTMLDetailsElement;
  details.addEventListener("toggle", () => saveOpenState(id, details.open));
  return details;
}

function renderPeriodsPanel(periods: PeriodsView, deposits: DepositsView | null, plan: PlanView): HTMLElement {
  // Group the exported months by their calendar year so each year folds away
  // independently (current year open by default).
  const monthsByYear = new Map<string, PeriodRowView[]>();
  for (const row of periods.monthly) {
    const yr = row.label.slice(0, 4);
    const bucket = monthsByYear.get(yr);
    if (bucket) bucket.push(row);
    else monthsByYear.set(yr, [row]);
  }

  // The current year is the live one (its yearly row is flagged current); fall
  // back to today's year so a fresh export with no current row still opens one.
  const currentYear =
    periods.yearly.find((y) => y.isCurrent)?.label ?? String(new Date().getFullYear());

  // Render newest year first; include any year that has a yearly row or months
  // so nothing is dropped.
  const yearKeys = Array.from(
    new Set<string>([...periods.yearly.map((y) => y.label), ...monthsByYear.keys()]),
  )
    .sort()
    .reverse();

  // --- Left column: all the periods, collapsible by year. ---
  const leftChildren: Array<Node | string> = [];
  if (yearKeys.length === 0) {
    leftChildren.push(h("p", { class: "note" }, ["No periods yet."]));
  }
  for (const year of yearKeys) {
    const yearRow = periods.yearly.find((y) => y.label === year);
    leftChildren.push(
      renderYearGroup(year, yearRow, monthsByYear.get(year) ?? [], year === currentYear),
    );
  }
  const left = h("div", { class: "periods-left" }, leftChildren);

  // --- Right column: contributions, then the independent projection settings
  // and the projection they drive — all stacked and collapsible. ---
  const rightChildren: Array<Node | string> = [];
  if (deposits) rightChildren.push(renderContributions(deposits));
  rightChildren.push(...renderPeriodsProjection(plan));
  const right = h("div", { class: "periods-right" }, rightChildren);

  const disclaimer = h("p", { class: "disclaimer" }, [
    "The current month and year are recomputed live; completed periods are frozen as of the last export. " +
      "Projected years are hypothetical and assume constant returns.",
  ]);

  return h("section", { class: "panel-stack panel-periods" }, [left, right, disclaimer]);
}

// --- Analytics / risk tab ---------------------------------------------------

/** Plain-language definitions for the (often cryptic) risk/return metrics. */
const METRIC_INFO: Record<string, string> = {
  CAGR: "Compound Annual Growth Rate — the smoothed yearly return that would take you from the start value to today.",
  TWR: "Time-Weighted Return — return that strips out the effect of deposits/withdrawals, so it measures the strategy, not the timing of cash.",
  XIRR: "Money-weighted annualised return (internal rate of return) that does account for the size and timing of your cash flows.",
  Alpha: "Excess return versus the benchmark after adjusting for market risk (beta). Positive means you beat the benchmark on a risk-adjusted basis.",
  Beta: "Sensitivity to the benchmark. 1.0 moves in line with it; above 1 is more volatile, below 1 is less.",
  "Risk-free": "Assumed return of a 'safe' asset (e.g. short-term government rate) used as the baseline for Sharpe/Sortino/Alpha.",
  Volatility: "Annualised standard deviation of returns — how much the value swings around. Higher means a bumpier ride.",
  Sharpe: "Return earned per unit of total risk (excess return ÷ volatility). Higher is better; above 1 is generally good.",
  Sortino: "Like Sharpe but only penalises downside volatility, so it ignores 'good' upside swings.",
  "Max drawdown": "The largest peak-to-trough drop over the period — the worst loss you would have sat through.",
  Calmar: "CAGR ÷ the absolute max drawdown — return relative to the worst drop. Higher is better.",
  "Ulcer index": "Measures the depth and duration of drawdowns. Lower means shallower, shorter declines.",
  "VaR 95%": "Value at Risk — the loss you would not expect to exceed on 95% of days (a typical bad day).",
  "CVaR 95%": "Conditional VaR — the average loss on the worst 5% of days, i.e. how bad the tail beyond VaR tends to be.",
  Skew: "Asymmetry of returns. Negative means occasional large losses; positive means occasional large gains.",
  Kurtosis: "'Fat tails' — how often extreme moves happen versus a normal bell curve. Higher means more surprises.",
};

/**
 * The single info tooltip currently pinned open by tap, plus a one-time set of
 * global dismiss listeners. A pinned tip behaves like a native tooltip: tapping
 * anywhere else, pressing Escape, or moving focus away closes it instead of
 * letting it linger on screen.
 */
let openInfoDot: HTMLButtonElement | null = null;
let infoDotDismissBound = false;

function closeOpenInfoDot(): void {
  if (openInfoDot) {
    openInfoDot.classList.remove("open");
    openInfoDot = null;
  }
}

function ensureInfoDotDismiss(): void {
  if (infoDotDismissBound || typeof document === "undefined") return;
  infoDotDismissBound = true;
  // A tap that bubbles up to the document (i.e. anywhere but the dot itself,
  // which calls stopPropagation) dismisses the pinned tip.
  document.addEventListener("click", closeOpenInfoDot);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeOpenInfoDot();
  });
}

/**
 * Nudge a just-revealed tooltip horizontally so it always stays on screen. The
 * tip is centred on its dot by default; for dots near the left/right edge of the
 * grid (or anywhere on a narrow phone) the centred 16rem popover used to spill
 * past the card/viewport. We measure it once shown and shift it back inside the
 * viewport — robust for every column and screen width, instead of guessing edges
 * with brittle :nth-child rules.
 */
function positionInfoTip(tip: HTMLElement): void {
  if (typeof window === "undefined") return;
  // Reset to the CSS default (centred) before measuring, so repeated opens don't
  // accumulate offsets.
  tip.style.transform = "";
  const rect = tip.getBoundingClientRect();
  // jsdom (tests) reports a zero-size rect; nothing to clamp there.
  if (rect.width === 0) return;
  const margin = 8;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  let shift = 0;
  if (rect.left < margin) shift = margin - rect.left;
  else if (rect.right > viewportWidth - margin) shift = viewportWidth - margin - rect.right;
  if (shift !== 0) tip.style.transform = `translateX(calc(-50% + ${shift}px))`;
}

/** A small tappable "i" that reveals a definition (hover/focus and tap). */
function infoDot(text: string): HTMLElement {
  const tip = h("span", { class: "info-tip", role: "tooltip" }, [text]);
  const button = h(
    "button",
    { class: "info-dot", type: "button", "aria-label": `What is this? ${text}` },
    [h("span", { "aria-hidden": "true" }, ["i"]), tip],
  ) as HTMLButtonElement;
  ensureInfoDotDismiss();
  // Hover-capable devices rely on CSS :hover, so the tip tracks the pointer and
  // vanishes on mouse-leave like a normal tooltip — no sticky pin. Only on
  // touch / no-hover devices (where :hover never fires) does a tap pin it open,
  // and then an outside tap, Escape, or blur closes it again.
  const canHover =
    typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches === true;
  // Clamp the popover into the viewport the moment it becomes visible, whichever
  // way it was triggered (pointer hover, keyboard focus, or tap-to-pin).
  button.addEventListener("mouseenter", () => positionInfoTip(tip));
  button.addEventListener("focus", () => positionInfoTip(tip));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (canHover) return;
    const wasOpen = button === openInfoDot;
    closeOpenInfoDot();
    if (!wasOpen) {
      button.classList.add("open");
      openInfoDot = button;
      positionInfoTip(tip);
    }
  });
  button.addEventListener("blur", () => {
    if (button === openInfoDot) closeOpenInfoDot();
  });
  return button;
}

/** A metric stat card whose label carries an info dot when a definition exists. */
function metricStat(metric: RiskMetric): HTMLElement {
  // Risk/return metrics are currency-dependent (they're computed on the curve's
  // daily returns, and FX varies day to day), so prefer the USD figure when USD
  // is selected — matching the headline/per-stock growth and the periods.
  const value = pickByCurrency(metric.value, metric.valueUsd);
  const cls = metric.kind === "pct" ? signClass(value) : "flat";
  const labelChildren: Array<Node | string> = [metric.label];
  const info = METRIC_INFO[metric.label];
  if (info) labelChildren.push(infoDot(info));
  return h("div", { class: "stat" }, [
    h("span", { class: "stat-label" }, labelChildren),
    h("span", { class: `stat-value ${cls}` }, [renderMetricValue(metric, value)]),
  ]);
}

function renderMetricValue(metric: RiskMetric, value: Decimal | null): string {
  if (value === null) return "—";
  if (metric.kind === "pct") return formatPercent(value);
  if (metric.kind === "money") return formatCurrency(value);
  return value.toNumber().toFixed(2);
}

function renderMetricGrid(metrics: RiskMetric[]): HTMLElement {
  return h("div", { class: "stat-grid" }, metrics.map(metricStat));
}

/**
 * Selectable look-back windows for the time-series charts. A preset is only
 * offered when the data actually spans longer than it (so we never show a "1Y"
 * button next to three months of history); "All" is always available. Works the
 * same on phone and desktop — it is just a row of buttons above the chart.
 */
const CHART_TIMEFRAMES: Array<{ label: string; days: number }> = [
  { label: "1M", days: 31 },
  { label: "3M", days: 91 },
  { label: "6M", days: 182 },
  { label: "1Y", days: 365 },
];

/** Whole days between two ISO `YYYY-MM-DD` dates (b assumed ≥ a). */
function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

/** A live range the value chart plots from device-cached intraday/daily bars. */
export type LiveRange = "1D" | "1W";

/** Chart-ready output of a live-curve build (already denominated and dated). */
export interface LiveCurveChart {
  dates: string[];
  series: ChartSeries[];
  yAxisLabel?: (value: number, fractionDigits?: number) => string;
  /** Legend rows to show beneath the live chart (series class → label). */
  legend?: Array<{ className: string; label: string }>;
  /** Optional horizontal reference line (e.g. the 1D curve's previous close). */
  referenceLine?: { value: Decimal; label?: string };
  /**
   * Optional honesty caption shown under the chart — e.g. the 1D curve drawn from
   * only part of the sleeve (scenario C), so a partly-flat line never masquerades
   * as a complete day.
   */
  note?: string;
  /**
   * The curve's own growth over the plotted window (a fraction, e.g. `0.012` for
   * +1.2%), measured on the *same* points and reference base the line draws — the
   * 1D curve from its dashed previous-close line, the 1W curve from its first
   * session. The headline beside the chart reads this so its percentage is
   * identical to the line the eye follows, for both 1D and 1W (and in whichever
   * currency the curve is denominated). `null` when it can't be measured.
   */
  growthPct?: Decimal | null;
}

/**
 * Lazily build a live 1D/1W curve for the value chart, returning
 * `null` when the curve can't be drawn (no data yet, missing key/proxy, or a
 * failed fetch). Only invoked when the user actually selects a live preset.
 */
export type LiveCurveBuilder = (
  range: LiveRange,
  opts?: { regenerateOnly?: boolean },
) => Promise<LiveCurveChart | null>;

/**
 * The app shell's hooks for the live value chart: each lazily
 * builds a whole-book curve (both currencies per point) for its range, returning
 * `null` when the curve can't be drawn. Currency denomination and overlays are
 * applied by the UI from the returned {@link CurvePoint}s, so the shell stays
 * currency-agnostic.
 */
/** A built live 1D session curve plus how much of the sleeve shaped it. */
export interface LiveSessionResult {
  points: CurvePoint[];
  /**
   * Sleeve coverage of the 1D curve: `covered`/`total` distinct intraday-priced
   * symbols the curve actually had bars for. `covered < total` means some
   * holdings were carried flat for want of bars, so the line understates the
   * day's true shape — surfaced as an honest caption (scenario C).
   */
  coverage?: { covered: number; total: number };
}

export interface LiveGraphHooks {
  /**
   * Build the live 1D (intraday) curve points, or null when unavailable. When
   * `opts.regenerateOnly` is set the build is pure (reconstruct from stored bars,
   * **zero network**) — every UI interaction (range toggle, graph click) passes
   * it so chart interaction never fetches; only the initial paint may pull.
   */
  session: (opts?: { regenerateOnly?: boolean }) => Promise<LiveSessionResult | null>;
  /** Build the live 1W (daily-close) curve points, or null when unavailable. */
  week: (opts?: { regenerateOnly?: boolean }) => Promise<CurvePoint[] | null>;
}

/** One selectable preset: either a history slice or a live (fetched) curve. */
export type RangeOption =
  | { label: string; kind: "history"; days: number | null }
  | { label: string; kind: "live"; range: LiveRange };

/**
 * The ordered preset set for the value chart, given the history `span` (days),
 * whether the optional extra (3M / 6M) ranges are enabled, and whether a live
 * builder is available.
 *
 * - **Default:** the live **1D** and **1W** curves (when a builder exists) plus
 *   the `1M` / `1Y` history slices that fit the span and "All". The longer
 *   `3M` / `6M` slices are omitted for a cleaner strip.
 * - **Extra ranges on:** adds the `3M` / `6M` history slices back.
 *
 * Returns `[]` when there is nothing worth toggling (no live presets and the
 * history is shorter than the smallest slice), so the caller draws a plain chart.
 */
export function chartTimeframeOptions(span: number, extended: boolean, hasLive: boolean): RangeOption[] {
  const historySource = extended
    ? CHART_TIMEFRAMES
    : CHART_TIMEFRAMES.filter((t) => t.label !== "3M" && t.label !== "6M");
  const presets = historySource.filter((t) => span > t.days + 5);
  const livePresets: RangeOption[] = hasLive
    ? [
        { label: "1D", kind: "live", range: "1D" },
        { label: "1W", kind: "live", range: "1W" },
      ]
    : [];
  if (presets.length === 0 && livePresets.length === 0) return [];
  return [
    ...livePresets,
    ...presets.map((p): RangeOption => ({ label: p.label, kind: "history", days: p.days })),
    { label: "All", kind: "history", days: null },
  ];
}

/**
 * A line chart wrapped with time-range presets. Builds the full chart, then —
 * when there is enough history to make a shorter window meaningful — adds a
 * small button group that re-slices the same series to the chosen look-back and
 * redraws in place (no re-fetch; purely a view of the already-loaded points).
 *
 * The live **1D** and **1W** curves are prepended whenever a {@link LiveCurveBuilder}
 * is supplied. The longer 3M / 6M slices are shown only when the optional extra
 * ranges are enabled ({@link extendedGraphsEnabled}). Selecting a live preset
 * fetches/builds its curve on demand (device-cached) and swaps it in.
 */
function chartWithTimeframe(
  dates: string[],
  series: ChartSeries[],
  chartOpts: { yAxisLabel?: (v: number) => string } = {},
  persistKey?: string,
  live?: LiveCurveBuilder,
  baseLegend?: Array<{ className: string; label: string }>,
  onRangeChange?: (option: RangeOption) => void,
  onLiveGrowth?: (option: RangeOption, growthPct: Decimal | null) => void,
): HTMLElement | null {
  const full = buildLineChart({ dates, series, ...chartOpts });
  if (!full) return null;
  // When a base legend is supplied the wrapper *owns* the legend, redrawing it
  // alongside each preset (history or live) so the chart never shows two copies —
  // the live re-draw used to duplicate a legend the caller also printed below.
  const legendEl = (rows: Array<{ className: string; label: string }>): HTMLElement =>
    h("div", { class: "chart-legend" }, rows.map((row) => legendItem(row.className, row.label)));
  const withLegend = (chart: HTMLElement, rows?: Array<{ className: string; label: string }>): HTMLElement[] =>
    rows && rows.length > 0 ? [chart, legendEl(rows)] : [chart];
  const wrap = h("div", { class: "chart-wrap" }, withLegend(full as unknown as HTMLElement, baseLegend));

  const span = dates.length >= 2 ? daysBetween(dates[0], dates[dates.length - 1]) : 0;
  const options = chartTimeframeOptions(span, extendedGraphsEnabled(), Boolean(live));
  // Nothing worth toggling (no live presets and history shorter than the smallest
  // slice): plain chart.
  if (options.length === 0) return wrap;

  const lastMs = Date.parse(dates[dates.length - 1]);
  const buttons: HTMLButtonElement[] = [];
  const storageKey = persistKey ? `${CHART_RANGE_KEY_PREFIX}${persistKey}` : null;
  // Monotonic token so a slow live fetch never overwrites a newer selection.
  let activeToken = 0;

  const liveStatus = (text: string): HTMLElement => h("div", { class: "chart-live-status note muted" }, [text]);

  // Mark a freshly drawn chart so the stylesheet can fade it in (a gentle
  // cross-fade keeps re-toggling 1D/1W/… calm instead of snapping). Purely
  // cosmetic — `prefers-reduced-motion` disables the animation in CSS.
  const enter = (chart: SVGSVGElement): SVGSVGElement => {
    chart.classList.add("chart-enter");
    return chart;
  };

  const applyHistory = (days: number | null): void => {
    let start = 0;
    if (days !== null) {
      const cutoff = lastMs - days * 86_400_000;
      start = dates.findIndex((d) => Date.parse(d) >= cutoff);
      if (start < 0) start = 0;
      // Always keep at least two points so the chart can still draw a line.
      if (dates.length - start < 2) start = Math.max(0, dates.length - 2);
    }
    const slicedDates = dates.slice(start);
    const slicedSeries = rebaseWindowOverlays(series.map((s) => ({ ...s, values: s.values.slice(start) })));
    const chart = buildLineChart({ dates: slicedDates, series: slicedSeries, ...chartOpts });
    if (chart) wrap.replaceChildren(...withLegend(enter(chart) as unknown as HTMLElement, baseLegend));
  };

  const applyLive = async (option: RangeOption & { kind: "live" }, token: number, regenerateOnly: boolean): Promise<void> => {
    if (!live) return;
    const range = option.range;
    // Defer the "Loading live data…" placeholder. A re-toggle (regenerate-only)
    // or any cache hit resolves almost instantly, so flashing the placeholder
    // for a single frame — and collapsing the chart's height with it — is the
    // visible "jump" when clicking 1D/1W. Holding the previous chart in place
    // for a short grace period lets a fast build swap straight in, calmly; only
    // a genuinely slow fetch ever shows the placeholder.
    let placeholderTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      placeholderTimer = null;
      if (token === activeToken) wrap.replaceChildren(liveStatus("Loading live data…"));
    }, LIVE_PLACEHOLDER_DELAY_MS);
    const clearPlaceholderTimer = (): void => {
      if (placeholderTimer !== null) {
        clearTimeout(placeholderTimer);
        placeholderTimer = null;
      }
    };
    let built: LiveCurveChart | null = null;
    try {
      built = await live(range, { regenerateOnly });
    } catch {
      built = null;
    }
    clearPlaceholderTimer();
    if (token !== activeToken) return; // a newer selection superseded this build
    if (!built) {
      wrap.replaceChildren(liveStatus("Live data isn't available yet — try refreshing."));
      return;
    }
    const chart = buildLineChart({
      dates: built.dates,
      series: built.series,
      yAxisLabel: built.yAxisLabel ?? chartOpts.yAxisLabel,
      referenceLine: built.referenceLine,
      // The "1W" curve collapses the dead time between sessions into per-day
      // bands (broken line + separators); the 1D single session stays plain.
      collapseSessions: range === "1W",
    });
    if (!chart) {
      wrap.replaceChildren(liveStatus("Not enough live points to draw a curve yet."));
      return;
    }
    // Re-draw the legend for the live series (e.g. the rebased other-currency
    // line) so a 1D/1W selection labels its own lines rather than inheriting the
    // exported-history legend. The wrapper owns the legend, so the caller no
    // longer prints a second copy beneath the chart. A coverage caption (e.g. a
    // 1D curve drawn from only part of the sleeve) is appended below the legend so
    // a partly-flat line never reads as a complete day (scenario C).
    const children = withLegend(enter(chart) as unknown as HTMLElement, built.legend);
    if (built.note) children.push(liveStatus(built.note));
    wrap.replaceChildren(...children);
    // Now that the live curve is drawn, refine the headline to the growth the
    // line itself shows (1D from its previous-close reference, 1W from its first
    // session) so the percentage is identical to the plotted line — superseding
    // the synchronous approximation `onRangeChange` set from exported history.
    // Only when the curve could measure it; otherwise the approximation stands.
    if (onLiveGrowth && built.growthPct !== null && built.growthPct !== undefined) {
      onLiveGrowth(option, built.growthPct);
    }
  };

  // `userInitiated` distinguishes a tap on a range button (Pillar 6: interaction
  // = regenerate, never poll → network-free) from the one initial restore on
  // mount (allowed to fetch for first paint until the pull mechanisms warm the
  // store). All live re-selection by the user is regenerate-only.
  const select = (index: number, persist = true, userInitiated = true): void => {
    const token = (activeToken += 1);
    const option = options[index];
    buttons.forEach((button, i) => {
      const active = i === index;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    // Remember the chosen window (by label, stable across exports) so it survives
    // the full re-render a refresh or currency toggle triggers.
    if (persist && storageKey) saveStringPref(storageKey, option.label);
    if (onRangeChange) onRangeChange(option);
    if (option.kind === "live") void applyLive(option, token, userInitiated);
    else applyHistory(option.days);
  };

  const controls = h("div", { class: "chart-range", role: "group", "aria-label": "Chart time range" }, []);
  options.forEach((option, index) => {
    const button = h("button", { class: "chart-range-btn", type: "button" }, [option.label]) as HTMLButtonElement;
    button.addEventListener("click", () => select(index));
    buttons.push(button);
    controls.appendChild(button);
  });
  // Reopen the remembered window (by label); default to the full history. This
  // sole initial selection is not user-initiated, so it may fetch for first paint.
  const savedLabel = storageKey ? loadStringPref(storageKey) : null;
  const savedIndex = savedLabel ? options.findIndex((o) => o.label === savedLabel) : -1;
  const initial = savedIndex >= 0 ? savedIndex : options.length - 1;
  select(initial, false, false);

  return h("div", { class: "chart-block" }, [controls, wrap]);
}

const CHART_RANGE_KEY_PREFIX = "iv.web.chartRange.";

/**
 * Grace period before a live (1D/1W) curve shows its "Loading…" placeholder.
 * Re-toggles and cache hits resolve well within this window, so they swap the
 * new chart straight in — no placeholder flash, no height collapse — keeping
 * range switching visually calm. Only a genuinely slow fetch trips the timer.
 */
const LIVE_PLACEHOLDER_DELAY_MS = 220;

/**
 * Rebase overlay series for the currently selected window so "benchmark" and
 * "other currency (rebased)" always anchor to that window's first portfolio
 * point (not only the full-history "All" anchor).
 */
export function rebaseWindowOverlays(series: ChartSeries[]): ChartSeries[] {
  const reference = series.find((s) => s.className === "series-portfolio")?.values;
  if (!reference) return series;
  return series.map((s) => {
    if (s.className !== "series-benchmark" && s.className !== "series-currency") return s;
    const rebased = rebaseToAnchor(s.values, reference);
    return rebased === null ? s : { ...s, values: rebased };
  });
}

/**
 * Resolve how a value/equity curve should be denominated for the active display
 * currency. The whole dashboard treats EUR and USD as equal first-class
 * currencies (EUR is only the internal FX-pivot, USD the native booked
 * currency); this picks the right per-point figure so the *graph* honours the
 * toggle too, not just the headline numbers.
 *
 * When the user has selected USD, a live rate is known, and the export carries
 * the per-day-FX `portfolioValueUsd` companion, the portfolio line uses that
 * genuinely currency-correct USD value (each historical day re-marked at *that*
 * day's FX) rather than rescaling the EUR curve by today's spot. EUR-pivot
 * overlays without a USD twin (contributions, the live tip) are spot-converted
 * so every series shares one axis. Otherwise everything stays in EUR.
 *
 * FX granularity matches the data: historical points use each day's settled FX
 * (the finest rate we store), while the live tip is valued at the current
 * intraday EUR/USD spot (see {@link renderValueChart}). The EUR and USD lines
 * therefore genuinely diverge — by the FX move at each point — instead of being
 * a single uniform rescale of one another.
 */
interface CurveDisplay {
  code: DisplayCurrency;
  /** Portfolio value for a point, in {@link code}. */
  portfolio: (p: EquityPoint) => Decimal | null;
  /** Convert an EUR-pivot amount into {@link code}. */
  convert: (eur: Decimal | null) => Decimal | null;
  /** y-axis tick formatter for values already in {@link code}. */
  yAxisLabel: (value: number, fractionDigits?: number) => string;
}

function curveDisplay(points: EquityPoint[]): CurveDisplay {
  const displayInUsd =
    getDisplayCurrency() === "USD" &&
    canConvertToUsd() &&
    points.some((p) => p.portfolioValueUsd !== null);
  const code: DisplayCurrency = displayInUsd ? "USD" : "EUR";
  const convert = (eur: Decimal | null): Decimal | null => {
    if (eur === null) return null;
    return code === "USD" ? convertFromEur(eur).value : eur;
  };
  const portfolio = (p: EquityPoint): Decimal | null =>
    displayInUsd && p.portfolioValueUsd !== null ? p.portfolioValueUsd : convert(p.portfolioValue);
  const yAxisLabel = (value: number, digits?: number): string =>
    formatCurrencyShortRaw(new Decimal(value), code, digits);
  return { code, portfolio, convert, yAxisLabel };
}

/**
 * Rebase the raw benchmark series so it shares the portfolio's scale.
 *
 * The export carries `benchmark_value` as the benchmark's *raw* closing level
 * (e.g. an index at ~110), which is orders of magnitude away from the portfolio
 * value (e.g. €40k). Plotted as-is on a shared y-axis the benchmark line is
 * pinned to the floor and looks flat — "the comparison line doesn't go up".
 *
 * Mirroring the desktop chart, we anchor the benchmark to the first non-zero
 * portfolio value: `benchmark[i] / benchmark[0] * portfolio[anchor]`. The two
 * lines then start together and the benchmark reads as a true "what if I'd held
 * the index instead?" curve. Returns the per-index values aligned with `points`
 * (null where the benchmark has no print yet).
 */
export function rebaseBenchmark(
  points: AnalyticsView["curve"],
  portfolioValues?: Array<Decimal | null>,
): Array<Decimal | null> {
  const portfolio = portfolioValues ?? points.map((p) => p.portfolioValue);
  const anchorBench = points.find((p) => p.benchmarkValue !== null)?.benchmarkValue ?? null;
  const anchorPortfolio = portfolio.find((v) => v !== null && v.greaterThan(0)) ?? null;
  // Without a usable anchor pair we cannot rescale; fall back to the raw values
  // rather than dropping the series entirely.
  if (anchorBench === null || anchorBench.isZero() || anchorPortfolio === null) {
    return points.map((p) => p.benchmarkValue);
  }
  return points.map((p) =>
    p.benchmarkValue === null ? null : p.benchmarkValue.dividedBy(anchorBench).times(anchorPortfolio),
  );
}

/**
 * Rescale `values` so its anchor coincides with `reference`'s anchor — the first
 * index where `reference` is a usable positive number. Both arrays must be
 * index-aligned. Returns `null` when no usable anchor pair exists (so the caller
 * can simply drop the series). Used to overlay a second *currency* line on the
 * shared single y-axis (see {@link secondaryCurrencyLine}): rebased, the two
 * lines start together and the gap that opens up is the genuine FX divergence
 * rather than a meaningless vertical offset from the ~1.08× EUR/USD level.
 */
export function rebaseToAnchor(
  values: Array<Decimal | null>,
  reference: Array<Decimal | null>,
): Array<Decimal | null> | null {
  const anchorIdx = reference.findIndex((v) => v !== null && v.greaterThan(0));
  if (anchorIdx < 0) return null;
  const anchorRef = reference[anchorIdx]!;
  const anchorVal = values[anchorIdx];
  if (anchorVal === null || anchorVal.isZero()) return null;
  return values.map((v) => (v === null ? null : v.dividedBy(anchorVal).times(anchorRef)));
}

/**
 * The *other* currency's portfolio line, rebased to share the primary line's
 * start, ready to overlay on the value/equity chart.
 *
 * The whole dashboard treats EUR and USD as equal first-class currencies, but a
 * raw second line would sit a flat ~1.08× away on the shared y-axis and read as
 * clutter. Instead the non-display currency's own per-point series (the genuine
 * per-day-FX USD companion when EUR is shown, the EUR pivot when USD is shown)
 * is rebased to the primary anchor, so both lines start together and visibly
 * *diverge* by the FX move over the window — the actual insight.
 *
 * `otherValues` must already be index-aligned with `primaryValues` (including any
 * appended live tip). Returns `null` — so the chart stays a single clean line —
 * unless a live FX rate is known and the other currency genuinely has data,
 * keeping the overlay uncluttered and opt-in exactly like the benchmark line.
 */
export function secondaryCurrencyLine(
  disp: CurveDisplay,
  otherValues: Array<Decimal | null>,
  primaryValues: Array<Decimal | null>,
): { code: DisplayCurrency; values: Array<Decimal | null> } | null {
  if (!canConvertToUsd()) return null;
  if (!otherValues.some((v) => v !== null)) return null;
  const rebased = rebaseToAnchor(otherValues, primaryValues);
  if (rebased === null) return null;
  return { code: disp.code === "USD" ? "EUR" : "USD", values: rebased };
}

/** The non-display currency's raw per-point portfolio value (pre-rebase). */
function otherCurrencyRaw(disp: CurveDisplay, p: EquityPoint): Decimal | null {
  // USD shown → the other line is the EUR pivot; EUR shown → the genuine
  // per-day-FX USD companion (never a spot rescale of the EUR pivot).
  return disp.code === "USD" ? p.portfolioValue : p.portfolioValueUsd;
}


/**
 * The Risk-tab equity curve: portfolio value vs. the cumulative-contributions
 * baseline and (when present) the benchmark, drawn with the shared axis-aware
 * line chart. Stamped as-of-export — history-bound, it does not move intraday.
 */
function renderEquityCurve(curve: AnalyticsView["curve"], benchmarkSymbol: string | null): HTMLElement | null {
  const points = curve.filter((p) => p.portfolioValue !== null);
  if (points.length < 2) return null;

  const dates = points.map((p) => p.date);
  const disp = curveDisplay(points);
  const portfolioValues = points.map(disp.portfolio);
  const series: ChartSeries[] = [
    { values: portfolioValues, className: "series-portfolio", area: true },
  ];
  const hasContribs = points.some((p) => p.contributions !== null);
  if (hasContribs) {
    series.push({ values: points.map((p) => disp.convert(p.contributions)), className: "series-contrib" });
  }
  const hasBenchmark = points.some((p) => p.benchmarkValue !== null);
  if (hasBenchmark) {
    series.push({ values: rebaseBenchmark(points, portfolioValues), className: "series-benchmark" });
  }
  // The other currency, rebased to the portfolio's start, so EUR and USD share
  // one axis and the gap between them reads as the FX move (not a flat offset).
  const currencyLine = secondaryCurrencyLine(
    disp,
    points.map((p) => otherCurrencyRaw(disp, p)),
    portfolioValues,
  );
  if (currencyLine !== null) {
    series.push({ values: currencyLine.values, className: "series-currency" });
  }

  const chart = chartWithTimeframe(dates, series, { yAxisLabel: disp.yAxisLabel }, "value");
  if (!chart) return null;

  const legend: Array<Node | string> = [legendItem("series-portfolio", "Portfolio")];
  if (hasContribs) legend.push(legendItem("series-contrib", "Contributions"));
  if (hasBenchmark) legend.push(legendItem("series-benchmark", benchmarkSymbol ?? "Benchmark"));
  if (currencyLine !== null) legend.push(legendItem("series-currency", `${currencyLine.code} (rebased)`));

  return h("section", { class: "card equity" }, [
    h("div", { class: "section-head" }, [
      h("h2", {}, ["Equity curve"]),
      h("span", { class: "muted" }, ["value over time"]),
    ]),
    chart,
    h("div", { class: "chart-legend" }, legend),
  ]);
}

/** A coloured swatch + label for a chart legend. */
function legendItem(seriesClass: string, label: string): HTMLElement {
  return h("span", { class: "legend-item" }, [
    h("span", { class: `legend-swatch ${seriesClass}`, "aria-hidden": "true" }, []),
    label,
  ]);
}

/**
 * The Risk-tab drawdown (underwater) chart.
 *
 * Computes the running-peak drawdown series from the equity curve and plots
 * it as a filled area (always ≤ 0) using the same SVG chart infrastructure
 * as the equity curve. The y-axis is labelled in percent rather than currency.
 * Returns null when there is insufficient data.
 */
function renderDrawdownChart(curve: AnalyticsView["curve"]): HTMLElement | null {
  // Drawdown is a ratio, so it differs between currencies by the day-to-day FX
  // drift: compute it on the active display currency's portfolio line so the
  // USD "underwater" curve reflects the dollar peak, not the euro one.
  const disp = curveDisplay(curve);
  const displayCurve = curve.map((p) => ({ ...p, portfolioValue: disp.portfolio(p) }));
  const dd = computeDrawdownSeries(displayCurve);
  // Only keep points where drawdown is defined and filter to those with usable dates.
  const points = dd.filter((p) => p.drawdown !== null);
  if (points.length < 2) return null;

  const dates = points.map((p) => p.date);
  const values: Array<Decimal | null> = points.map((p) => p.drawdown);

  // Format y-axis as signed percent (e.g. "−15.3%").
  const pctLabel = (v: number): string => {
    const pct = (v * 100).toFixed(1);
    return v < 0 ? `−${Math.abs(Number(pct))}%` : `${pct}%`;
  };

  const chart = chartWithTimeframe(dates, [{ values, className: "series-drawdown", area: true }], { yAxisLabel: pctLabel }, "drawdown");
  if (!chart) return null;

  return h("section", { class: "card drawdown" }, [
    h("div", { class: "section-head" }, [
      h("h2", {}, ["Drawdown"]),
      h("span", { class: "muted" }, ["underwater from peak"]),
    ]),
    chart,
    h("div", { class: "chart-legend" }, [
      legendItem("series-drawdown", "Drawdown from peak"),
    ]),
  ]);
}

/**
 * Map a built live curve ({@link CurvePoint}s carrying both currencies) into a
 * chart-ready {@link LiveCurveChart}, denominated in the active display currency
 * with the other currency overlaid (rebased to share the axis) — the same
 * treatment {@link renderValueChart} gives the exported history. Returns null
 * when there are too few points to draw.
 *
 * `prevClose` (the previous session's settled total, in EUR and USD) is supplied
 * only for the intraday 1D curve: when present, a neutral dashed reference line
 * marks it so the user reads whether the live value sits above or below where the
 * portfolio last *closed* — exactly as the desktop "1 Day" chart does.
 */
export function liveCurveToChart(
  points: CurvePoint[],
  prevClose?: { eur: Decimal | null; usd: Decimal | null } | null,
  coverage?: { covered: number; total: number } | null,
): LiveCurveChart | null {
  const cols = curveColumns(points);
  if (cols.dates.length < 2) return null;
  const inUsd = getDisplayCurrency() === "USD" && canConvertToUsd();
  const code: DisplayCurrency = inUsd ? "USD" : "EUR";
  const primary: Array<Decimal | null> = inUsd ? cols.usd : cols.eur;
  const series: ChartSeries[] = [{ values: primary, className: "series-portfolio", area: true }];
  // Overlay the other currency, rebased to the start, so EUR and USD diverge by
  // the FX move rather than sitting a flat ~1.08× apart (mirrors renderValueChart).
  const other: Array<Decimal | null> = inUsd ? cols.eur : cols.usd;
  const currencyLine = secondaryCurrencyLine({ code } as CurveDisplay, other, primary);
  const legend: Array<{ className: string; label: string }> = [
    { className: "series-portfolio", label: code },
  ];
  if (currencyLine !== null) {
    series.push({ values: currencyLine.values, className: "series-currency" });
    legend.push({ className: "series-currency", label: `${currencyLine.code} (rebased)` });
  }
  const yAxisLabel = (value: number, digits?: number): string =>
    formatCurrencyShortRaw(new Decimal(value), code, digits);
  // The previous-session close (display-currency value) as a dashed reference
  // line, marked only when it is known for the active currency.
  const prevCloseValue = prevClose ? (inUsd ? prevClose.usd : prevClose.eur) : null;
  const referenceLine =
    prevCloseValue !== null && prevCloseValue !== undefined
      ? { value: prevCloseValue, label: `Prev close ${formatMoneyRaw(prevCloseValue, code)}` }
      : undefined;
  // Honest coverage caption: when the curve was reconstructed from fewer than all
  // of the sleeve's holdings, the rest were carried flat for want of bars, so the
  // line understates the day's true shape. Say so rather than let a partly-flat
  // curve read as a complete day (scenario C). Only meaningful when some — but not
  // all — holdings have bars; full coverage (or a curve with no sleeve) stays quiet.
  const note =
    coverage && coverage.total > 0 && coverage.covered < coverage.total
      ? `Intraday shape from ${coverage.covered} of ${coverage.total} holdings — the rest are held flat until their prices load.`
      : undefined;
  // Growth the *line* actually draws, in the active currency, so the headline
  // beside it reads the same rise/fall the eye follows — identical to the pixel,
  // for both 1D and 1W. The 1D curve measures from its dashed previous-close
  // reference (what "% today" is anchored to); the 1W curve, which has no
  // reference line, measures from its first plotted point. The tip is the last
  // plotted point either way.
  const growthPct = curveGrowthPct(primary, prevCloseValue);
  return { dates: cols.dates, series, yAxisLabel, legend, referenceLine, note, growthPct };
}

/**
 * Growth of a plotted value series from its base to its tip, as a fraction
 * (`(tip − base) / base`). The base is the supplied previous-close reference when
 * known (the 1D curve, so the figure matches its dashed line), else the first
 * plotted value (the 1W curve). Returns null when there is no positive base or no
 * tip — so the headline simply keeps its prior value rather than showing a bogus
 * percentage.
 */
export function curveGrowthPct(
  values: Array<Decimal | null>,
  base?: Decimal | null,
): Decimal | null {
  const tip = lastNonNull(values);
  const start = base ?? firstNonNull(values);
  if (tip === null || start === null || start.lessThanOrEqualTo(0)) return null;
  return tip.minus(start).dividedBy(start);
}

/** The first non-null entry of a sparse series, or null when all are null. */
function firstNonNull(values: Array<Decimal | null>): Decimal | null {
  for (const v of values) if (v !== null) return v;
  return null;
}

/** The last non-null entry of a sparse series, or null when all are null. */
function lastNonNull(values: Array<Decimal | null>): Decimal | null {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null) return values[i];
  return null;
}

/**
 * Splice the device's persisted whole-book daily closes into the gap between the
 * last exported point and today. When the export blob is stale (weeks old) but the
 * app is opened daily, those days were recorded live (and harvested from the 1W
 * curve), so the long-range chart draws a real per-day line across the gap instead
 * of a single straight diagonal. Only closes strictly *after* the last exported
 * day and strictly *before* `asOf` (today's live tip owns `asOf`) are added; an
 * up-to-date blob already covers the range, so nothing is spliced.
 */
export function spliceDailyBackfill(
  points: EquityPoint[],
  backfill: DailyClose[],
  asOf: string,
): EquityPoint[] {
  if (backfill.length === 0) return points;
  const lastDate = points[points.length - 1].date;
  const extra: EquityPoint[] = backfill
    .filter((c) => c.date > lastDate && c.date < asOf)
    .map((c) => ({
      date: c.date,
      portfolioValue: c.valueEur,
      portfolioValueUsd: c.valueUsd,
      contributions: null,
      benchmarkValue: null,
    }));
  return extra.length === 0 ? points : [...points, ...extra];
}

/**
 * The Overview "value over time" graph. Reuses the exported equity curve and
 * appends today's live total value as the final point, so the headline figure
 * is the tip of the line. Returns null when no usable history was exported.
 */
function renderValueChart(
  analytics: AnalyticsView | null,
  o: OverviewView,
  liveGraph?: LiveGraphHooks,
  backfill: DailyClose[] = [],
): HTMLElement | null {
  if (analytics === null) return null;
  const exported = analytics.curve.filter((p) => p.portfolioValue !== null);
  if (exported.length < 1) return null;
  // Rebuild the gap a stale blob leaves with the device's persisted daily closes
  // before any windowing / live-tip work, so all of it just sees a denser curve.
  const points = spliceDailyBackfill(exported, backfill, o.asOf);

  const dates = points.map((p) => p.date);
  // Denominate in the active display currency. USD is the native booked currency
  // (spot prices arrive in USD) so its line is the genuine per-day-FX USD value,
  // not a rescale of the EUR pivot; EUR is the FX-derived view. See curveDisplay.
  const disp = curveDisplay(points);
  const values: Array<Decimal | null> = points.map(disp.portfolio);
  // Cumulative contributions per point in the active display currency, kept
  // index-aligned with `values` (including the live tip below) so the headline
  // can read the same window the graph draws and compute a money-weighted
  // (XIRR-scaled) growth over it. EUR is the FX-pivot; spot-convert for USD.
  const contribDisplay: Array<Decimal | null> = points.map((p) => disp.convert(p.contributions));
  // The other currency's raw per-point series, kept index-aligned with `values`
  // (including the live tip below) so it can be rebased onto the same axis.
  const otherValues: Array<Decimal | null> = points.map((p) => otherCurrencyRaw(disp, p));
  const otherCode: DisplayCurrency = disp.code === "USD" ? "EUR" : "USD";
  // Today's live total in the chart currency: USD uses the native live total
  // directly (no FX), EUR is spot-converted from it.
  const liveTotal =
    disp.code === "USD" ? o.totalValueUsd ?? disp.convert(o.totalValueEur) : o.totalValueEur;
  // The same live tip expressed in the *other* currency, so its line runs to
  // "today" too (USD/EUR native total — the rebase only uses its shape).
  const otherLiveTip = otherCode === "USD" ? o.totalValueUsd : o.totalValueEur;

  // Append today's live total as the latest point when it is newer than the
  // last exported point, so the curve runs right up to "today" — but only when
  // the live total is complete. If some holdings could not be valued live (no
  // price or no FX rate) they fall out of the sum, so the tip would under-count
  // the portfolio and draw a false dip; in that case stop at the last
  // fully-valued exported point.
  const lastDate = dates[dates.length - 1];
  if (o.totalValueIsComplete && liveTotal !== null) {
    if (o.asOf > lastDate) {
      dates.push(o.asOf);
      values.push(liveTotal);
      otherValues.push(otherLiveTip);
      // The live tip pays in no new contributions; carry the last cumulative
      // figure forward so the window's net-flow stays correct.
      contribDisplay.push(contribDisplay[contribDisplay.length - 1]);
    } else if (o.asOf === lastDate) {
      values[values.length - 1] = liveTotal;
      otherValues[otherValues.length - 1] = otherLiveTip;
    }
  }
  if (values.filter((v) => v !== null).length < 2) return null;

  const series: ChartSeries[] = [{ values, className: "series-portfolio", area: true }];
  // Overlay the other currency, rebased to share this line's start, so EUR and
  // USD diverge by the FX move rather than sitting a flat ~1.08× apart.
  const currencyLine = secondaryCurrencyLine(disp, otherValues, values);
  if (currencyLine !== null) {
    series.push({ values: currencyLine.values, className: "series-currency" });
  }

  // Live 1D/1W are now always on: wire the builders so their presets fetch and
  // draw on demand whenever a live graph is available. The 1D curve marks the
  // previous session's settled close as a dashed reference line — the same cue
  // the desktop "1 Day" chart draws. We anchor it on the live "today" baseline
  // (`totalValue − todayMove`, in each currency) rather than the last exported
  // settled point, so the rule lands exactly where the headline "% today" is
  // measured from. The two can differ — the exported point may be an older
  // session or carry a different FX snapshot — which left the line at the wrong
  // height (e.g. hugging the live value while the day was clearly down). Fall
  // back to the last exported point only when no live move is known.
  const lastPoint = points[points.length - 1];
  const prevClose =
    o.todayMovePct !== null
      ? {
          eur: o.totalValueEur.minus(o.todayMoveEur),
          usd:
            o.totalValueUsd !== null && o.todayMoveUsd !== null
              ? o.totalValueUsd.minus(o.todayMoveUsd)
              : null,
        }
      : { eur: lastPoint.portfolioValue, usd: lastPoint.portfolioValueUsd };
  const liveBuilder: LiveCurveBuilder | undefined =
    liveGraph
      ? async (range, opts) => {
          if (range === "1D") {
            const built = await liveGraph.session(opts);
            if (!built) return null;
            return liveCurveToChart(built.points, prevClose, built.coverage);
          }
          const built = await liveGraph.week(opts);
          if (!built) return null;
          return liveCurveToChart(built, null);
        }
      : undefined;

  // The legend rows for the exported history; the chart wrapper owns rendering
  // them (and swaps in the live preset's own legend) so only one copy is ever
  // shown — the chart used to print a second, duplicate legend below itself.
  const baseLegend = currencyLine !== null
    ? [
        { className: "series-portfolio", label: disp.code },
        { className: "series-currency", label: `${currencyLine.code} (rebased)` },
      ]
    : undefined;

  const todayPct = pickByCurrency(o.todayMovePct, o.todayMovePctUsd);
  const todayCls = signClass(pickByCurrency(o.todayMoveEur, o.todayMoveUsd));
  // The 1D curve draws the most recent session that has *started* (lastSessionDate).
  // When the market is shut — a weekend, a holiday, before today's open — that is
  // not today, so naming the headline "today" misreads the line. Label it by the
  // session the graph actually shows: "today", "yesterday", or the date if older.
  const oneDayLabel = formatSessionDayLabel(lastSessionDate(), exchangeDate());
  // The full-history "All" window's money-weighted growth IS the overview's
  // "Total growth" KPI (compounded XIRR over the invested lifetime). Reuse it
  // verbatim so the headline matches that KPI exactly, instead of re-deriving it
  // from the curve — at inception the opening value is ~0 (freshly deposited cash
  // isn't a market position yet), which made the XIRR seed collapse to a wildly
  // inflated Modified-Dietz fallback (e.g. 345% against a true 70%).
  const allTimeGrowth = pickByCurrency(o.totalGrowthCompoundedPct, o.totalGrowthCompoundedPctUsd);
  // The headline beside the chart tracks the *selected* window so it matches the
  // graph: 1D reuses today's close-to-now move (measured from the previous
  // CLOSE, like the intraday graph's reference line); 1W a simple period growth;
  // anything longer an XIRR-scaled (money-weighted) growth so weekly DCA deposits
  // don't make the number look wild. Defaults to the 1D session label until a
  // range is chosen (and stays there when there is nothing to toggle).
  const headlineSpan = h("span", { class: `muted ${todayCls}` }, [
    todayPct !== null ? `${formatSignedPercent(todayPct)} ${oneDayLabel}` : oneDayLabel,
  ]) as HTMLElement;
  const lastWindowMs = Date.parse(dates[dates.length - 1]);
  const sliceWindow = (days: number | null): WindowPoint[] => {
    let start = 0;
    if (days !== null) {
      const cutoff = lastWindowMs - days * 86_400_000;
      start = dates.findIndex((d) => Date.parse(d) >= cutoff);
      if (start < 0) start = 0;
      if (dates.length - start < 2) start = Math.max(0, dates.length - 2);
    }
    return dates.slice(start).map((d, i) => ({
      date: d,
      value: values[start + i],
      contributions: contribDisplay[start + i],
    }));
  };
  const headlineLabel = (option: RangeOption): string =>
    option.kind === "live" && option.range === "1D" ? oneDayLabel : option.label;
  const setHeadline = (pct: Decimal | null, label: string): void => {
    headlineSpan.className = `muted ${signClass(pct)}`;
    headlineSpan.textContent =
      pct !== null ? `${formatSignedPercent(pct)} ${label}` : label;
  };
  const updateHeadline = (option: RangeOption): void => {
    let pct: Decimal | null;
    if (option.kind === "live" && option.range === "1D") {
      pct = todayPct;
    } else if (option.kind === "history" && option.days === null) {
      // "All" — show the lifetime compounded growth (the "Total growth" KPI).
      pct = allTimeGrowth;
    } else {
      // 1W (live, ~7 day window) uses simple growth; every longer history slice
      // uses XIRR-scaled growth.
      const days = option.kind === "live" ? 7 : option.days;
      const mode: GrowthMode = option.kind === "live" ? "simple" : "xirr";
      pct = windowGrowthPct(sliceWindow(days), mode);
    }
    setHeadline(pct, headlineLabel(option));
  };
  // Once a live (1D/1W) curve has actually been drawn, snap the headline to the
  // growth the *line* shows — measured on the same plotted points and currency —
  // so the percentage is identical to the pixel for both ranges, rather than the
  // exported-history approximation `updateHeadline` paints synchronously first.
  const updateLiveHeadline = (option: RangeOption, growthPct: Decimal | null): void => {
    setHeadline(growthPct, headlineLabel(option));
  };

  const chart = chartWithTimeframe(
    dates,
    series,
    { yAxisLabel: disp.yAxisLabel },
    "portfolio",
    liveBuilder,
    baseLegend,
    updateHeadline,
    updateLiveHeadline,
  );
  if (!chart) return null;

  // Only surface a note when there is something the user actually needs to know
  // about the curve's honesty — not a redundant date stamp on every render.
  let note: string | null = null;
  if (!o.totalValueIsComplete) {
    note = "Live total is incomplete (missing prices or FX rates), so the curve stops at the last fully-valued day.";
  } else if (o.staleValueSymbols.length > 0) {
    note = `Last exported value used for ${o.staleValueSymbols.join(", ")} (no live price available).`;
  }
  const children: Array<Node | string> = [
    h("div", { class: "section-head" }, [
      h("h2", {}, ["Value over time"]),
      headlineSpan,
    ]),
    chart,
  ];
  if (note) children.push(h("p", { class: "note" }, [note]));
  return h("section", { class: "card value-chart" }, children);
}

const ATTRIBUTION_PAGE_SIZE = 8;

/** A single attribution row (P/L by holding) as a compact ledger line. */
function attributionRowEl(symbol: string, pnl: Decimal | null, pct: Decimal | null, isTotalRow = false): HTMLElement {
  return h("li", { class: `ledger-row${isTotalRow ? " attr-total" : ""}` }, [
    h("div", { class: "ledger-id" }, [
      h("span", { class: "ledger-kind" }, [symbol]),
      h("span", { class: "ledger-sub muted" }, [pct !== null ? `${formatPercent(pct)} of return` : "—"]),
    ]),
    h("span", { class: `ledger-amount ${signClass(pnl)}` }, [formatSignedCurrency(pnl)]),
  ]);
}

/**
 * Per-holding attribution — the browser port of the desktop analytics table.
 * Mirrors the desktop by listing *every* valued holding (not just a top slice)
 * and pinning a "Total" row that foots the per-holding P/L back to the window
 * total. Long lists paginate so the section never grows tall enough to overlap
 * the charts around it.
 */
function renderAttribution(rows: AnalyticsView["attribution"]): HTMLElement | null {
  const valued = rows.filter((r) => r.absolutePnlEur !== null);
  if (valued.length === 0) return null;

  // Totals foot the table back to the window P/L and ~100 % of return.
  const totalPnl = valued.reduce<Decimal>((acc, r) => acc.plus(r.absolutePnlEur ?? 0), new Decimal(0));
  const hasPct = valued.some((r) => r.pctOfTotalReturn !== null);
  const totalPct = hasPct
    ? valued.reduce<Decimal>((acc, r) => acc.plus(r.pctOfTotalReturn ?? 0), new Decimal(0))
    : null;
  const totalRow = attributionRowEl("Total", totalPnl, totalPct, true);

  const pageCount = Math.ceil(valued.length / ATTRIBUTION_PAGE_SIZE);
  const list = h("ul", { class: "ledger-list" }, []);

  const body: Array<Node | string> = [list];
  let renderPage: (page: number) => void;

  if (pageCount > 1) {
    let page = 0;
    const prev = h("button", { class: "attr-page-btn", type: "button", "aria-label": "Previous page" }, ["‹"]);
    const next = h("button", { class: "attr-page-btn", type: "button", "aria-label": "Next page" }, ["›"]);
    const label = h("span", { class: "attr-page-label muted" }, []);
    renderPage = (p: number): void => {
      page = Math.max(0, Math.min(p, pageCount - 1));
      const start = page * ATTRIBUTION_PAGE_SIZE;
      const slice = valued.slice(start, start + ATTRIBUTION_PAGE_SIZE);
      const items = slice.map((r) => attributionRowEl(r.symbol, r.absolutePnlEur, r.pctOfTotalReturn));
      list.replaceChildren(...items, totalRow);
      label.textContent = `Page ${page + 1} / ${pageCount}`;
      prev.toggleAttribute("disabled", page === 0);
      next.toggleAttribute("disabled", page === pageCount - 1);
    };
    prev.addEventListener("click", () => renderPage(page - 1));
    next.addEventListener("click", () => renderPage(page + 1));
    body.push(h("div", { class: "attr-pager" }, [prev, label, next]));
  } else {
    renderPage = (): void => {
      const items = valued.map((r) => attributionRowEl(r.symbol, r.absolutePnlEur, r.pctOfTotalReturn));
      list.replaceChildren(...items, totalRow);
    };
  }
  renderPage(0);

  const sub = `${valued.length} ${valued.length === 1 ? "holding" : "holdings"}`;
  return collapsibleSection("Attribution", sub, h("div", { class: "attribution-body" }, body), "card attribution");
}

/**
 * The Risk tab's "Currency (EUR ↔ USD)" panel — the browser port of the
 * desktop analytics page's currency-effect section. It is the headline USD/EUR
 * *comparison* for a euro investor holding dollar assets: it always shows both
 * sides at once (the average rate you bought dollars at vs today's spot, and
 * the slice of your return that came from the FX move rather than the assets),
 * so it reads correctly whichever display currency is toggled. Returns null
 * when there isn't enough cross-currency data to say anything useful.
 */
function renderCurrencyEffect(overview: OverviewView, deposits: DepositsView | null): HTMLElement | null {
  const effect = computeCurrencyEffect({
    contributionsEur: deposits?.totalEur ?? overview.totalCostBasisEur,
    contributionsUsd: deposits?.totalUsd ?? overview.totalCostBasisUsd,
    valueEur: overview.totalValueEur,
    valueUsd: overview.totalValueUsd,
    growthEur: overview.totalGrowthCompoundedPct,
    growthUsd: overview.totalGrowthCompoundedPctUsd,
  });
  if (effect.currentRate === null && effect.avgInvestRate === null) return null;

  const cards: HTMLElement[] = [];
  const effectStat = (label: string, value: string, sub: string, cls = "flat"): HTMLElement =>
    h("div", { class: "stat" }, [
      h("span", { class: "stat-label" }, [label]),
      h("span", { class: `stat-value ${cls}` }, [value]),
      h("span", { class: "stat-sub muted" }, [sub]),
    ]);

  cards.push(
    effectStat(
      "EUR/USD now",
      formatFxRate(effect.currentRate),
      `avg in: ${formatFxRate(effect.avgInvestRate)}`,
    ),
  );
  if (effect.rateChangePct !== null) {
    // A weaker euro (a *lower* rate, negative change) is a tailwind for a euro
    // investor holding dollars, so colour by favourability (−change), not raw sign.
    const weaker = effect.rateChangePct.isNegative();
    cards.push(
      effectStat(
        "Euro since buying",
        formatSignedPercent(effect.rateChangePct),
        weaker ? "weaker → tailwind" : "stronger → headwind",
        signClass(effect.rateChangePct.negated()),
      ),
    );
  }
  if (effect.currencyEffectPp !== null) {
    cards.push(
      effectStat(
        "FX effect on return",
        formatSignedPercent(effect.currencyEffectPp),
        "EUR − USD return",
        signClass(effect.currencyEffectPp),
      ),
    );
  }
  if (effect.fxPnlEur !== null) {
    cards.push(
      effectStat(
        "FX gain / loss",
        formatSignedMoneyEur(effect.fxPnlEur),
        "vs your avg rate",
        signClass(effect.fxPnlEur),
      ),
    );
  }
  if (effect.repatriationValueEur !== null) {
    const usdNote = effect.currentRate !== null ? `at ${formatFxRate(effect.currentRate)}` : "value back in EUR";
    cards.push(effectStat("If cashed out now", formatMoneyEur(effect.repatriationValueEur), usdNote));
  }

  const body = h("div", { class: "currency-effect-body" }, [
    h("p", { class: "note" }, [
      "You fund in EUR but hold USD assets, so the EUR/USD move is its own gain or loss. A weaker euro helps you.",
    ]),
    h("section", { class: "stats" }, [h("div", { class: "stat-grid" }, cards)]),
  ]);
  return collapsibleSection("Currency (EUR ↔ USD)", "FX effect", body, "currency-effect", true);
}

function renderAnalyticsPanel(
  analytics: AnalyticsView | null,
  overview: OverviewView,
  deposits: DepositsView | null,
): HTMLElement {
  if (analytics === null) {
    return h("section", { class: "panel-stack" }, [
      h("section", { class: "card" }, [
        sectionHead("Risk & analytics"),
        h("p", { class: "note" }, ["No analytics were included in this export."]),
      ]),
    ]);
  }

  const children: Array<Node | string> = [
    h("section", { class: "card analytics-returns" }, [
      h("div", { class: "section-head" }, [
        h("h2", {}, ["Returns"]),
        h("span", { class: "muted" }, [`as of ${analytics.asOf}`]),
      ]),
      renderMetricGrid(analytics.returns),
    ]),
    h("section", { class: "card analytics-risk" }, [
      h("div", { class: "section-head" }, [
        h("h2", {}, ["Risk"]),
        h("span", { class: "muted" }, [analytics.benchmarkSymbol ? `vs ${analytics.benchmarkSymbol}` : "history-based"]),
      ]),
      renderMetricGrid(analytics.risk),
    ]),
  ];

  // Risk-tab body order: equity curve, then the currency comparison, then
  // attribution, and finally the drawdown chart (see the matching desktop grid
  // areas in styles.css). The currency comparison is always visible (it shows
  // both EUR and USD at once), never gated on the toggle.
  const curve = renderEquityCurve(analytics.curve, analytics.benchmarkSymbol);
  if (curve) children.push(curve);
  const currencyEffect = renderCurrencyEffect(overview, deposits);
  if (currencyEffect) children.push(currencyEffect);
  const attribution = renderAttribution(analytics.attribution);
  if (attribution) children.push(attribution);
  const drawdown = renderDrawdownChart(analytics.curve);
  if (drawdown) children.push(drawdown);

  children.push(
    h("p", { class: "disclaimer" }, [
      `Risk metrics are as of the last desktop export (${analytics.start} → ${analytics.asOf}) and don't move intraday.`,
    ]),
  );
  return h("section", { class: "panel-stack panel-analytics" }, children);
}

// --- Plan / projection tab --------------------------------------------------

function numberField(label: string, value: string, attrs: Attrs): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "number", inputmode: "decimal", value, ...attrs }) as HTMLInputElement;
  const wrap = h("label", { class: "field" }, [h("span", { class: "field-label" }, [label]), input]);
  return { wrap, input };
}

/**
 * The full Calculator tab, replacing the old Plan panel.
 *
 * All inputs are seeded from the encrypted export blob (starting value from
 * the live portfolio total, contribution from average historical contribution,
 * expected return from the portfolio XIRR). The user can adjust everything;
 * the simulation re-runs in-browser on each keystroke with no network call.
 *
 * Mirrors the desktop's _projection_view / _projection_model (req 11).
 */

/** The reusable pieces of the projection calculator, so the same engine can be
 *  mounted both on its own Calculator tab and (decoupled) inside the Periods
 *  tab. {@link buildCalculator} wires the form to the outputs; callers arrange
 *  the pieces into whatever layout they need. */
interface CalculatorParts {
  /** The settings card (inputs + toggles). When `headless`, its own section
   *  head is dropped so a surrounding collapsible can supply the title. */
  form: HTMLElement;
  kpiOut: HTMLElement;
  goalOut: HTMLElement;
  tableOut: HTMLElement;
}

interface CalculatorOptions {
  /** Drop the form's internal section-head (the wrapper supplies a title). */
  headless?: boolean;
  /** Called after every recompute with a short collapsed-state summary line
   *  (e.g. "~€1.2M expected by 2036"), so a collapsed projection can still
   *  show where the outlook lands without being unfolded. */
  onSummary?: (text: string) => void;
}

/**
 * Build the projection calculator engine: a settings form wired to live KPI,
 * goal and table outputs. Fully self-contained — it reads only {@link PlanView}
 * and the active display currency, so it works identically on the Calculator
 * tab and embedded in the Periods tab even if the Calculator tab goes away.
 */
function buildCalculator(plan: PlanView, opts: CalculatorOptions = {}): CalculatorParts {
  // The calculator runs in EUR internally; the user types in the active display
  // currency and the values are converted before simulating.
  const displayCurrency = getDisplayCurrency();
  const isUsd = displayCurrency === "USD";

  // Seed the expected rate from the portfolio XIRR (EUR or USD depending on
  // which display currency is active; fall back to FALLBACK_EXPECTED_RATE).
  const seedRate = isUsd && plan.expectedRateUsd !== null
    ? plan.expectedRateUsd
    : plan.expectedRateEur;
  const seedRatePct = seedRate.times(100).toDecimalPlaces(2).toString();

  // Seed contribution from the average historical value (monthly or yearly).
  // The horizon default is yearly (10 years / 120 months). The period mode is
  // remembered across re-renders (e.g. a currency toggle) so a "selected
  // something" choice survives — see PROJ_KEYS.
  let monthly = loadBoolPref(PROJ_KEYS.monthly, false);
  const seedYearlyContrib = convertFromEur(plan.defaultAnnualContributionEur);
  const seedMonthlyContrib = convertFromEur(plan.defaultMonthlyContributionEur);
  const code = seedYearlyContrib.code;

  const getDefaultContrib = (): string =>
    monthly
      ? seedMonthlyContrib.value.toDecimalPlaces(0).toString()
      : seedYearlyContrib.value.toDecimalPlaces(0).toString();

  // Re-seed a stored display-currency value: money fields persist in EUR, so a
  // saved figure converts cleanly into whichever currency is now active.
  const seedMoneyDisplay = (key: string, fallbackDisplay: string): string => {
    const saved = loadStringPref(key);
    if (saved === null) return fallbackDisplay;
    try {
      return convertFromEur(new Decimal(saved)).value.toDecimalPlaces(0).toString();
    } catch {
      return fallbackDisplay;
    }
  };
  const saveMoneyEur = (key: string, displayValue: string): void => {
    let amount: Decimal;
    try {
      amount = new Decimal(displayValue || 0);
    } catch {
      return;
    }
    const eur = isUsd ? convertToEur(amount) : amount;
    saveStringPref(key, eur.toString());
  };

  // --- Controls (each seeded from its remembered value, falling back to the
  // portfolio-derived default). ---
  const expectedRate = numberField(`Expected return % p.a.`, loadStringPref(PROJ_KEYS.rate) ?? seedRatePct, { min: "-50", max: "40", step: "0.1" });
  const band = numberField("± band (pp)", loadStringPref(PROJ_KEYS.band) ?? "3.0", { min: "0", max: "30", step: "0.5" });
  const contribution = numberField(
    `Contribution / ${monthly ? "month" : "year"} (${code})`,
    seedMoneyDisplay(PROJ_KEYS.contribEur, getDefaultContrib()),
    { min: "0", step: "10" },
  );
  const contribLabel = contribution.wrap.querySelector(".field-label");
  const stepUp = numberField("Annual step-up %", loadStringPref(PROJ_KEYS.stepUp) ?? "0", { min: "0", max: "100", step: "0.5" });
  const inflation = numberField("Inflation %", loadStringPref(PROJ_KEYS.inflation) ?? "2.0", { min: "0", max: "30", step: "0.1" });
  const target = numberField(`Target value (${code})`, seedMoneyDisplay(PROJ_KEYS.targetEur, "0"), { min: "0", step: "1000" });

  // Horizon: years (1–40) or months (1–480), default 10y / 120m.
  const horizonInput = numberField(
    monthly ? "Horizon (months)" : "Horizon (years)",
    loadStringPref(PROJ_KEYS.horizon) ?? (monthly ? "120" : "10"),
    { min: "1", max: monthly ? "480" : "40", step: "1" },
  );
  const horizonLabel = horizonInput.wrap.querySelector(".field-label");

  // Period toggle (yearly / monthly), reflecting the remembered mode.
  const btnYearly = h("button", { class: `chart-range-btn${monthly ? "" : " active"}`, type: "button" }, ["Yearly"]) as HTMLButtonElement;
  const btnMonthly = h("button", { class: `chart-range-btn${monthly ? " active" : ""}`, type: "button" }, ["Monthly"]) as HTMLButtonElement;
  btnYearly.setAttribute("aria-pressed", monthly ? "false" : "true");
  btnMonthly.setAttribute("aria-pressed", monthly ? "true" : "false");

  // "Today's money" (real / nominal) toggle.
  const realToggleInput = h("input", { type: "checkbox", id: "calc-real" }) as HTMLInputElement;
  if (loadBoolPref(PROJ_KEYS.real, false)) realToggleInput.checked = true;
  const realToggle = h("label", { class: "calc-toggle-label", for: "calc-real" }, [
    realToggleInput,
    " Show in today's money (real)",
  ]);

  // Output containers.
  const kpiOut = h("div", { class: "calc-kpi-wrap" }, []);
  const goalOut = h("div", { class: "calc-goal-wrap" }, []);
  const tableOut = h("div", { class: "calc-table-wrap" }, []);

  // --- Core simulation ---
  const recompute = (): void => {
    const ratePct = parseFloat(expectedRate.input.value) || 7;
    const bandPpt = Math.max(0, parseFloat(band.input.value) || 3);
    const stepUpPct = Math.max(0, parseFloat(stepUp.input.value) || 0);
    const inflationPct = Math.max(0, parseFloat(inflation.input.value) || 0);
    const horizonRaw = Math.max(1, parseInt(horizonInput.input.value) || (monthly ? 120 : 10));
    const periods = monthly ? Math.min(horizonRaw, 480) : Math.min(horizonRaw, 40);
    const periodsPerYear = monthly ? 12 : 1;

    // Parse contribution and target in display currency, convert to EUR.
    const contribDisplay = Math.max(0, parseFloat(contribution.input.value) || 0);
    const contribEur = isUsd
      ? convertToEur(new Decimal(contribDisplay))
      : new Decimal(contribDisplay);

    const targetDisplay = Math.max(0, parseFloat(target.input.value) || 0);
    const targetEur = isUsd
      ? convertToEur(new Decimal(targetDisplay))
      : new Decimal(targetDisplay);

    const useReal = realToggleInput.checked;

    const expectedDecimal = new Decimal(ratePct).dividedBy(100);
    const bandDecimal = new Decimal(bandPpt).dividedBy(100);
    const rates = bandRates(expectedDecimal, bandDecimal);

    const params: ProjectionParams = {
      startingValue: plan.startingValueEur,
      baseContribution: contribEur,
      periods,
      periodsPerYear,
      annualRates: rates,
      annualContributionGrowth: new Decimal(stepUpPct).dividedBy(100),
      inflationRate: new Decimal(inflationPct).dividedBy(100),
      start: new Date(Date.UTC(plan.baseYear, 0, 1)),
    };

    const result = simulate(params);
    const last = finalPoint(result);

    // --- KPI cards ---
    const scenarios = [
      { key: SCENARIO_PESSIMISTIC, label: "Pessimistic" },
      { key: SCENARIO_EXPECTED,    label: "Expected" },
      { key: SCENARIO_OPTIMISTIC,  label: "Optimistic" },
    ] as const;

    const kpiCards = scenarios.map(({ key, label }) => {
      const finalVal = last
        ? (useReal ? last.realByScenario[key] : last.nominalByScenario[key])
        : plan.startingValueEur;
      const displayVal = convertFromEur(finalVal).value;
      return h("div", { class: "stat" }, [
        h("span", { class: "stat-label" }, [label]),
        h("span", { class: "stat-value pos" }, [formatCurrencyWhole(displayVal)]),
        h("span", { class: "stat-sub muted" }, [last ? `in ${last.label}` : "—"]),
      ]);
    });

    const contribTotal = totalContributed(result);
    const contribTotalDisplay = convertFromEur(contribTotal).value;
    kpiCards.push(
      h("div", { class: "stat" }, [
        h("span", { class: "stat-label" }, ["Contributed"]),
        h("span", { class: "stat-value" }, [formatCurrencyWhole(contribTotalDisplay)]),
        h("span", { class: "stat-sub muted" }, ["total new money"]),
      ]),
    );

    kpiOut.replaceChildren(
      h("section", { class: "stats" }, [
        h("div", { class: "stat-grid calc-summary" }, kpiCards),
      ]),
    );

    // Feed a one-line collapsed summary (where the "Expected" scenario lands at
    // the horizon) to any caller that wants to show it without unfolding.
    if (opts.onSummary) {
      const expectedScenario = last
        ? (useReal ? last.realByScenario[SCENARIO_EXPECTED] : last.nominalByScenario[SCENARIO_EXPECTED])
        : null;
      const expectedFinal = expectedScenario !== null ? convertFromEur(expectedScenario).value : null;
      opts.onSummary(
        expectedFinal !== null
          ? `~${formatCurrencyWhole(expectedFinal)} expected by ${last!.label}`
          : "forward outlook",
      );
    }

    // --- Goal-seeking callout (only when target > 0) ---
    if (targetEur.greaterThan(0)) {
      const hits = timeToTarget(result, targetEur, { real: useReal });
      const reqContrib = requiredContribution(params, targetEur);
      const reqDisplay = reqContrib !== null
        ? `${formatCurrencyWhole(convertFromEur(reqContrib).value)} / ${monthly ? "month" : "year"}`
        : "not reachable in this horizon";

      const hitLines = scenarios.map(({ key, label }) => {
        const hit = hits[key];
        const text = hit ? `${label}: ${hit.label} (${hit.years.toDecimalPlaces(1)} yr)` : `${label}: not reached`;
        return h("div", { class: "calc-hit-row" }, [text]);
      });

      goalOut.replaceChildren(
        h("section", { class: "card calc-goal" }, [
          h("div", { class: "section-head" }, [
            h("h2", {}, ["Goal"]),
            h("span", { class: "muted" }, [`target: ${formatCurrencyWhole(convertFromEur(targetEur).value)}`]),
          ]),
          h("div", { class: "calc-goal-body" }, [
            h("div", { class: "calc-hit-list" }, hitLines),
            h("div", { class: "calc-req" }, [
              h("span", { class: "stat-label" }, ["Needed contribution"]),
              h("span", { class: "stat-value" }, [reqDisplay]),
            ]),
          ]),
        ]),
      );
    } else {
      goalOut.replaceChildren();
    }

    // --- Per-period table ---
    // In monthly mode only show annual milestones (every 12th row) to keep the
    // table mobile-friendly; in yearly mode show every year.
    const tablePoints = monthly
      ? result.points.filter((p) => p.index % 12 === 0)
      : result.points;

    const colHeaders = scenarios.map(({ label }) =>
      h("span", { class: "proj-cell muted" }, [label.slice(0, 4)]),
    );

    const tableRows = tablePoints.map((pt) => {
      const cells = scenarios.map(({ key }) => {
        const v = useReal ? pt.realByScenario[key] : pt.nominalByScenario[key];
        return h("span", { class: "proj-cell" }, [formatCurrencyWhole(convertFromEur(v).value)]);
      });
      return h("li", { class: "proj-row" }, [
        h("span", { class: "proj-year" }, [pt.label]),
        h("span", { class: "proj-contrib muted" }, [`+${formatCurrencyWhole(convertFromEur(pt.contributed).value)}`]),
        h("div", { class: "proj-values" }, cells),
      ]);
    });

    tableOut.replaceChildren(
      h("section", { class: "card" }, [
        h("div", { class: "proj-head" }, [
          h("span", { class: "proj-year muted" }, [monthly ? "Month" : "Year"]),
          h("span", { class: "proj-contrib muted" }, ["Contributed"]),
          h("div", { class: "proj-values" }, colHeaders),
        ]),
        h("ul", { class: "proj-list" }, tableRows),
      ]),
    );
  };

  // --- Toggle handlers ---
  const switchMode = (toMonthly: boolean): void => {
    if (monthly === toMonthly) return;
    monthly = toMonthly;
    saveBoolPref(PROJ_KEYS.monthly, monthly);
    btnYearly.classList.toggle("active", !monthly);
    btnMonthly.classList.toggle("active", monthly);
    btnYearly.setAttribute("aria-pressed", monthly ? "false" : "true");
    btnMonthly.setAttribute("aria-pressed", monthly ? "true" : "false");
    horizonInput.input.max = monthly ? "480" : "40";
    horizonInput.input.value = monthly ? "120" : "10";
    if (horizonLabel) horizonLabel.textContent = monthly ? "Horizon (months)" : "Horizon (years)";
    if (contribLabel) contribLabel.textContent = `Contribution / ${monthly ? "month" : "year"} (${code})`;
    contribution.input.value = getDefaultContrib();
    // Switching the period mode deliberately reseeds horizon + contribution, so
    // persist those fresh defaults too (otherwise the next render would restore
    // the previous mode's figures).
    saveStringPref(PROJ_KEYS.horizon, horizonInput.input.value);
    saveMoneyEur(PROJ_KEYS.contribEur, contribution.input.value);
    recompute();
  };

  btnYearly.addEventListener("click", () => switchMode(false));
  btnMonthly.addEventListener("click", () => switchMode(true));

  // Wire all inputs to recompute, and persist each so the typed value survives a
  // re-render (e.g. a currency toggle). Plain (currency-independent) fields store
  // verbatim; money fields store their EUR equivalent.
  const plainPersist: Array<[{ input: HTMLInputElement }, string]> = [
    [expectedRate, PROJ_KEYS.rate],
    [band, PROJ_KEYS.band],
    [stepUp, PROJ_KEYS.stepUp],
    [inflation, PROJ_KEYS.inflation],
    [horizonInput, PROJ_KEYS.horizon],
  ];
  for (const [field, key] of plainPersist) {
    field.input.addEventListener("input", () => saveStringPref(key, field.input.value));
  }
  contribution.input.addEventListener("input", () => saveMoneyEur(PROJ_KEYS.contribEur, contribution.input.value));
  target.input.addEventListener("input", () => saveMoneyEur(PROJ_KEYS.targetEur, target.input.value));
  for (const field of [expectedRate, band, contribution, stepUp, inflation, target, horizonInput]) {
    field.input.addEventListener("input", recompute);
  }
  realToggleInput.addEventListener("change", () => {
    saveBoolPref(PROJ_KEYS.real, realToggleInput.checked);
    recompute();
  });

  const form = h("section", { class: "card calc-form" }, [
    ...(opts.headless
      ? []
      : [
          h("div", { class: "section-head" }, [
            h("h2", {}, ["Calculator"]),
            h("span", { class: "muted" }, ["from today's portfolio"]),
          ]),
        ]),
    h("p", { class: "note" }, [
      `Seeded from your portfolio: starting value ${formatCurrency(plan.startingValueEur)}, ` +
      `expected return ${seedRatePct}% p.a. (from portfolio XIRR). Adjust below.`,
    ]),
    h("div", { class: "calc-period-toggle" }, [
      h("div", { class: "chart-range", role: "group", "aria-label": "Period type" }, [btnYearly, btnMonthly]),
      realToggle,
    ]),
    h("div", { class: "calc-fields" }, [
      expectedRate.wrap, band.wrap, contribution.wrap, stepUp.wrap,
      inflation.wrap, target.wrap, horizonInput.wrap,
    ]),
  ]);

  recompute();
  return { form, kpiOut, goalOut, tableOut };
}

/**
 * The standalone Calculator tab: an allocation/invest planner. The user sets
 * a target mix (by category or fund) and a cash contribution; we turn it into
 * a concrete buy-only — or, with rebalancing on, buy/sell — plan that says how
 * much to invest in each fund. A TS port of the desktop app's calculator; saved
 * target allocations from the encrypted blob can be loaded with one tap. (The
 * forward projection lives under Periods via {@link renderPeriodsProjection}.)
 */
function renderCalculatorPanel(data: CalcData): HTMLElement {
  const ZERO = new Decimal(0);
  const HUNDRED = new Decimal(100);
  const code = getDisplayCurrency();

  // --- Builder state ---
  // The category/fund target mode is remembered so the choice survives a
  // re-render (e.g. a currency toggle), like the other calculator prefs below.
  let mode: "category" | "fund" = loadStringPref(CALC2_MODE_KEY) === "fund" ? "fund" : "category";
  const isUsd = code === "USD";
  // Persisted toggles (survive reloads, like the desktop's calc.* prefs): allow
  // the plan to sell over-weight funds, and allow buying fractional shares.
  let allowSell = loadBoolPref(CALC_REBALANCE_KEY);
  let fractional = loadBoolPref(CALC_FRACTIONAL_KEY);
  const catTargets = new Map<string, number>();
  const catSplit = new Map<string, "value" | "equal">();
  const catSelected = new Map<string, Set<string>>();
  const fundTargets = new Map<string, number>();
  const catMembers = new Map<string, string[]>();
  for (const c of data.categories) {
    catSplit.set(c.name, "value");
    catSelected.set(c.name, new Set(c.members.map((m) => m.symbol)));
    catMembers.set(c.name, c.members.map((m) => m.symbol));
  }
  const categoryOf = new Map(data.instruments.map((i) => [i.symbol, i.category]));
  const currentPctOf = new Map(data.instruments.map((i) => [i.symbol, i.currentPct]));
  const nameOf = new Map(data.instruments.map((i) => [i.symbol, i.name]));
  const valueOf = new Map(data.instruments.map((i) => [i.symbol, i.currentValueEur]));
  const priceOf = new Map(data.instruments.map((i) => [i.symbol, i.priceEur]));

  // --- Formatting helpers ---
  const fmt = (eur: Decimal): string => formatCurrency(eur);
  const pct1 = (d: Decimal): string => `${d.toDecimalPlaces(1).toFixed(1)}%`;
  const numOr0 = (v: string): Decimal => {
    if (v === "" || v === null) return ZERO;
    try {
      return new Decimal(v);
    } catch {
      return ZERO;
    }
  };

  // --- Output containers ---
  const summaryBox = h("div", {}, []);
  const builderBox = h("div", { class: "calc2-builder" }, []);
  const resultBox = h("div", { class: "calc2-result" }, []);
  const noticeBox = h("p", { class: "note calc2-notice", hidden: "hidden" }, []);
  const totalBar = h("div", { class: "calc2-total-bar" }, [
    h("div", { class: "calc2-total-fill" }, []),
  ]);
  const totalLabel = h("span", { class: "calc2-total-label" }, []);

  function notify(message: string): void {
    noticeBox.textContent = message;
    noticeBox.removeAttribute("hidden");
  }
  function clearNotice(): void {
    noticeBox.textContent = "";
    noticeBox.setAttribute("hidden", "hidden");
  }

  /** A small bar overlaying the current weight under the target marker. */
  function bar(currentPct: Decimal, targetPct: Decimal, addedFrom: Decimal | null = null): HTMLElement {
    const cur = Math.max(0, Math.min(100, currentPct.toNumber()));
    const tgt = Math.max(0, Math.min(100, targetPct.toNumber()));
    const children: HTMLElement[] = [
      h("div", { class: "calc2-bar-cur", style: `width:${cur}%` }, []),
    ];
    if (addedFrom !== null) {
      const start = Math.max(0, Math.min(cur, addedFrom.toNumber()));
      if (cur - start > 1e-9) {
        const width = Math.max(cur - start, 3);
        const left = Math.max(0, cur - width);
        children.push(h("div", { class: "calc2-bar-add", style: `left:${left}%;width:${width}%` }, []));
      }
    }
    children.push(h("div", { class: "calc2-bar-target", style: `left:calc(${tgt}% - 1px)` }, []));
    return h("div", { class: "calc2-bar" }, children);
  }

  // --- Summary ---
  function renderSummary(): void {
    const held = data.instruments.filter((i) => i.currentValueEur.greaterThan(0)).length;
    summaryBox.replaceChildren(
      h("section", { class: "stats" }, [
        h("div", { class: "stat-grid calc2-summary calc2-summary-overview" }, [
          h("div", { class: "stat" }, [
            h("span", { class: "stat-label" }, ["Portfolio value"]),
            h("span", { class: "stat-value" }, [fmt(data.totalValueEur)]),
          ]),
          h("div", { class: "stat" }, [
            h("span", { class: "stat-label" }, ["Holdings"]),
            h("span", { class: "stat-value" }, [String(held)]),
          ]),
          h("div", { class: "stat" }, [
            h("span", { class: "stat-label" }, ["Categories"]),
            h("span", { class: "stat-value" }, [String(data.categories.length)]),
          ]),
        ]),
      ]),
    );
  }

  // --- Live total ---
  function currentTotal(): Decimal {
    let total = ZERO;
    const src = mode === "category" ? catTargets : fundTargets;
    for (const v of src.values()) total = total.plus(new Decimal(v || 0));
    return total;
  }
  function updateTotal(): void {
    const total = currentTotal();
    const fill = totalBar.querySelector(".calc2-total-fill") as HTMLElement | null;
    if (fill) fill.style.width = `${Math.min(100, total.toNumber())}%`;
    const onTarget = total.minus(HUNDRED).abs().lessThanOrEqualTo(new Decimal("0.05"));
    totalLabel.classList.toggle("on-target", onTarget && total.greaterThan(0));
    if (total.isZero()) {
      totalLabel.textContent = "No targets set yet";
    } else if (onTarget) {
      totalLabel.textContent = `${pct1(total)} ✓`;
    } else {
      const diff = HUNDRED.minus(total);
      const verb = diff.greaterThan(0) ? "more" : "over";
      totalLabel.textContent = `${pct1(total)} (normalised to 100% on compute; ${pct1(diff.abs())} ${verb})`;
    }
  }

  // --- Builder rows ---
  function setCatTarget(name: string, value: string): void {
    catTargets.set(name, numOr0(value).toNumber());
    updateBars();
    updateTotal();
  }
  function setFundTarget(symbol: string, value: string): void {
    fundTargets.set(symbol, numOr0(value).toNumber());
    updateBars();
    updateTotal();
  }
  // Re-paint just the bars in place (cheaper than a full builder re-render) so
  // the target marker tracks typing without losing input focus.
  function updateBars(): void {
    for (const el of builderBox.querySelectorAll<HTMLElement>("[data-bar-row]")) {
      const key = el.getAttribute("data-bar-row")!;
      const current = el.getAttribute("data-bar-current")!;
      const tgt =
        mode === "category" ? catTargets.get(key) : fundTargets.get(key);
      const fresh = bar(new Decimal(current), new Decimal(tgt ?? 0));
      const holder = el.querySelector(".calc2-bar-holder");
      if (holder) holder.replaceChildren(fresh);
    }
  }

  function renderCategoryRow(cat: CalcCategory): HTMLElement {
    const input = h("input", {
      type: "number",
      inputmode: "decimal",
      min: "0",
      step: "0.1",
      class: "calc2-target-input",
      "aria-label": `Target percent for ${cat.name}`,
      value: catTargets.has(cat.name) ? String(catTargets.get(cat.name)) : "",
    }) as HTMLInputElement;
    input.addEventListener("input", () => setCatTarget(cat.name, input.value));

    const barHolder = h("div", { class: "calc2-bar-holder" }, [
      bar(cat.currentPct, new Decimal(catTargets.get(cat.name) ?? 0)),
    ]);

    const memberRows = cat.members.map((m) => {
      const cb = h("input", {
        type: "checkbox",
        class: "calc2-member-cb",
      }) as HTMLInputElement;
      cb.checked = catSelected.get(cat.name)!.has(m.symbol);
      cb.addEventListener("change", () => {
        const set = catSelected.get(cat.name)!;
        if (cb.checked) set.add(m.symbol);
        else set.delete(m.symbol);
      });
      return h("label", { class: "calc2-member" }, [
        cb,
        h("span", {}, [`${m.symbol} · ${m.name} (${pct1(m.currentPct)})`]),
      ]);
    });

    const splitToggle = makeMiniToggle(
      [
        { value: "value", label: "Fair by value" },
        { value: "equal", label: "Even" },
      ],
      catSplit.get(cat.name) ?? "value",
      (v) => catSplit.set(cat.name, v as "value" | "equal"),
    );

    const expandId = `calc2-funds-${cat.name}`;
    const expandAttrs: Attrs = { class: "calc2-funds" };
    if (loadOpenState(expandId, false)) expandAttrs.open = "open";
    const expansion = h("details", expandAttrs, [
      h("summary", {}, ["Funds in this category"]),
      h("div", { class: "calc2-funds-body" }, [
        h("div", { class: "calc2-split" }, [h("span", { class: "muted" }, ["Split:"]), splitToggle]),
        h("p", { class: "note" }, [
          "Untick a fund you don't invest in: the funds you do tick share this " +
            "category's whole % between them, and the un-ticked fund just keeps " +
            "its current holding (left to dilute over time).",
        ]),
        ...memberRows,
      ]),
    ]) as HTMLDetailsElement;
    expansion.addEventListener("toggle", () => saveOpenState(expandId, expansion.open));

    return h(
      "div",
      {
        class: "calc2-row",
        "data-bar-row": cat.name,
        "data-bar-current": cat.currentPct.toString(),
      },
      [
        h("div", { class: "calc2-row-main" }, [
          h("div", { class: "calc2-row-label" }, [
            h("span", { class: "calc2-row-name" }, [cat.name]),
            h("span", { class: "calc2-row-sub muted" }, [
              `now ${pct1(cat.currentPct)} · ${fmt(cat.currentValueEur)}`,
            ]),
          ]),
          barHolder,
          h("label", { class: "calc2-target" }, [input, h("span", { class: "calc2-suffix" }, ["%"])]),
        ]),
        expansion,
      ],
    );
  }

  function renderFundRow(instr: CalcInstrument): HTMLElement {
    const input = h("input", {
      type: "number",
      inputmode: "decimal",
      min: "0",
      step: "0.1",
      class: "calc2-target-input",
      "aria-label": `Target percent for ${instr.symbol}`,
      value: fundTargets.has(instr.symbol) ? String(fundTargets.get(instr.symbol)) : "",
    }) as HTMLInputElement;
    input.addEventListener("input", () => setFundTarget(instr.symbol, input.value));

    return h(
      "div",
      {
        class: "calc2-row",
        "data-bar-row": instr.symbol,
        "data-bar-current": instr.currentPct.toString(),
      },
      [
        h("div", { class: "calc2-row-main" }, [
          h("div", { class: "calc2-row-label" }, [
            h("span", { class: "calc2-row-name" }, [`${instr.symbol} · ${instr.name}`]),
            h("span", { class: "calc2-row-sub muted" }, [
              `${instr.category} · now ${pct1(instr.currentPct)}`,
            ]),
          ]),
          h("div", { class: "calc2-bar-holder" }, [
            bar(instr.currentPct, new Decimal(fundTargets.get(instr.symbol) ?? 0)),
          ]),
          h("label", { class: "calc2-target" }, [input, h("span", { class: "calc2-suffix" }, ["%"])]),
        ]),
      ],
    );
  }

  function renderBuilder(): void {
    const rows: HTMLElement[] =
      mode === "category"
        ? data.categories.map(renderCategoryRow)
        : [...data.instruments]
            .sort((a, b) => b.currentValueEur.comparedTo(a.currentValueEur))
            .map(renderFundRow);
    builderBox.replaceChildren(...rows);
    updateTotal();
  }

  // --- Presets ---
  function presetCurrent(): void {
    if (mode === "category") {
      catTargets.clear();
      for (const c of data.categories) catTargets.set(c.name, c.currentPct.toDecimalPlaces(1).toNumber());
    } else {
      fundTargets.clear();
      for (const i of data.instruments) {
        if (i.currentPct.greaterThan(0)) fundTargets.set(i.symbol, i.currentPct.toDecimalPlaces(1).toNumber());
      }
    }
    renderBuilder();
  }
  function presetEqual(): void {
    if (mode === "category") {
      const cats = data.categories;
      const share = cats.length ? new Decimal(100).dividedBy(cats.length).toDecimalPlaces(1).toNumber() : 0;
      catTargets.clear();
      for (const c of cats) catTargets.set(c.name, share);
    } else {
      const held = data.instruments.filter((i) => i.currentValueEur.greaterThan(0));
      const pool = held.length ? held : data.instruments;
      const share = pool.length ? new Decimal(100).dividedBy(pool.length).toDecimalPlaces(1).toNumber() : 0;
      fundTargets.clear();
      for (const i of pool) fundTargets.set(i.symbol, share);
    }
    renderBuilder();
  }
  function presetClear(): void {
    catTargets.clear();
    fundTargets.clear();
    renderBuilder();
  }
  function loadSaved(target: SavedTarget): void {
    // Group each saved fund's weight under its category, ticking only funds the
    // saved plan actually bought (no-buy members stay counted but un-ticked).
    const catTotals = new Map<string, number>();
    const selectedInSaved = new Map<string, Set<string>>();
    for (const item of target.items) {
      const category = categoryOf.get(item.symbol);
      if (category === undefined) continue;
      catTotals.set(category, (catTotals.get(category) ?? 0) + item.weightPct.toNumber());
      if (!item.noBuy) {
        if (!selectedInSaved.has(category)) selectedInSaved.set(category, new Set());
        selectedInSaved.get(category)!.add(item.symbol);
      }
    }
    catTargets.clear();
    for (const [name, value] of catTotals) catTargets.set(name, new Decimal(value).toDecimalPlaces(1).toNumber());
    for (const c of data.categories) catSelected.set(c.name, new Set(c.members.map((m) => m.symbol)));
    for (const category of catTotals.keys()) {
      if (catSelected.has(category)) catSelected.set(category, selectedInSaved.get(category) ?? new Set());
    }
    fundTargets.clear();
    for (const item of target.items) fundTargets.set(item.symbol, item.weightPct.toDecimalPlaces(1).toNumber());
    mode = "category";
    allowSell = target.allowSell;
    rebalanceCb.checked = allowSell;
    modeToggle.select("category");
    renderBuilder();
    clearNotice();
  }

  // --- Build weights from the current state ---
  function buildWeights(): { raw: Map<string, Decimal>; noBuy: Set<string> } | null {
    if (mode === "category") {
      const catWeights = new Map<string, Decimal>();
      for (const [name, v] of catTargets) {
        const d = new Decimal(v || 0);
        if (d.greaterThan(0)) catWeights.set(name, d);
      }
      if (catWeights.size === 0) {
        notify("Set at least one category target.");
        return null;
      }
      const weights = new Map<string, Decimal>();
      for (const [name, weight] of catWeights) {
        const members = catMembers.get(name) ?? [];
        if (members.length === 0) continue;
        // Split the category's % across only the funds the user actually invests
        // in (the ticked ones). Funds left un-ticked don't get a slice — the
        // invested funds "pick up the slack" and absorb the whole category target
        // between them, while the un-ticked funds simply keep their current
        // holding (left to dilute as more cash flows into the funds the user does
        // buy). A positive-target category with nothing ticked is rejected.
        const selected = members.filter((sym) => (catSelected.get(name) ?? new Set()).has(sym));
        if (selected.length === 0) {
          notify(`Tick at least one fund to invest in for “${name}”, or set its target to 0.`);
          return null;
        }
        const expanded = expandCategoryWeights(
          new Map([[name, weight]]),
          new Map([[name, selected]]),
          valueOf,
          catSplit.get(name) ?? "value",
        );
        for (const [sym, w] of expanded) weights.set(sym, (weights.get(sym) ?? ZERO).plus(w));
      }
      return { raw: weights, noBuy: new Set() };
    }
    const weights = new Map<string, Decimal>();
    for (const [sym, v] of fundTargets) {
      const d = new Decimal(v || 0);
      if (d.greaterThan(0)) weights.set(sym, d);
    }
    if (weights.size === 0) {
      notify("Set at least one fund target.");
      return null;
    }
    return { raw: weights, noBuy: new Set() };
  }

  function compute(): void {
    clearNotice();
    const built = buildWeights();
    if (built === null) return;
    const targetPct = scaleTo100(built.raw);
    if (targetPct.size === 0) {
      notify("Targets must be positive.");
      return;
    }
    const cashDisplay = numOr0(cashInput.value);
    if (cashDisplay.lessThan(0) || (cashDisplay.isZero() && !allowSell)) {
      notify("Enter a positive cash amount (or turn on rebalancing to sell only).");
      return;
    }
    const cashEur = convertToEur(cashDisplay);
    // In buy-only "by category" mode, credit funds the user holds but left
    // un-ticked toward their category's funding: they join the plan as held,
    // never-bought rows (0 % target) so an already well-funded category —
    // counting those held funds — asks for no fresh cash even when the ticked
    // fund alone still looks under-weight.
    const noBuy = new Set([...built.noBuy].filter((s) => targetPct.has(s)));
    let planCategoryOf: Map<string, string> | undefined;
    if (mode === "category" && !allowSell) {
      for (const [name, v] of catTargets) {
        if (!new Decimal(v || 0).greaterThan(0)) continue;
        const selected = catSelected.get(name) ?? new Set<string>();
        for (const sym of catMembers.get(name) ?? []) {
          if (selected.has(sym) || targetPct.has(sym)) continue;
          if (!(valueOf.get(sym) ?? ZERO).greaterThan(0)) continue;
          targetPct.set(sym, ZERO);
          noBuy.add(sym);
        }
      }
      planCategoryOf = new Map(
        [...targetPct.keys()].map((sym) => [sym, categoryOf.get(sym) ?? UNCATEGORIZED]),
      );
    }
    const currentPrices = new Map<string, Decimal>();
    for (const sym of targetPct.keys()) {
      const p = priceOf.get(sym);
      if (p) currentPrices.set(sym, p);
    }
    let plan: RebalancePlan;
    try {
      plan = planRebalance(cashEur, targetPct, valueOf, {
        currentPrices,
        allowFractionalShares: fractional,
        allowSell,
        noBuyIds: noBuy,
        categoryOf: planCategoryOf,
      });
    } catch (err) {
      notify(`Cannot rebalance: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    renderResult(plan, cashEur);
  }

  // --- Result ---
  function planRowEl(name: string, r: RebalanceRow, afterPct: Decimal, beforePct: Decimal, indent: boolean): HTMLElement {
    const current = currentPctOf.get(r.symbol) ?? ZERO;
    let valueEl: HTMLElement;
    if (r.addValue.greaterThan(0)) {
      const shares = r.addShares.greaterThan(0) ? ` · ${formatShares(r.addShares)} sh` : "";
      valueEl = h("span", { class: "calc2-add pos" }, [`+ ${fmt(r.addValue)}${shares}`]);
    } else if (r.addValue.lessThan(0)) {
      const shares = r.addShares.lessThan(0) ? ` · ${formatShares(r.addShares.negated())} sh` : "";
      valueEl = h("span", { class: "calc2-add neg" }, [`- ${fmt(r.addValue.negated())} sell${shares}`]);
    } else if (r.noBuy) {
      valueEl = h("span", { class: "calc2-add muted" }, ["held · no new cash"]);
    } else {
      valueEl = h("span", { class: "calc2-add muted" }, ["no buy"]);
    }
    return h("div", { class: indent ? "calc2-plan-row indent" : "calc2-plan-row" }, [
      h("div", { class: "calc2-row-label" }, [
        h("span", { class: "calc2-row-name" }, [name]),
        h("span", { class: "calc2-row-sub muted" }, [
          `now ${pct1(current)} → ${pct1(afterPct)} after · target ${pct1(r.targetPct)}`,
        ]),
      ]),
      h("div", { class: "calc2-bar-holder" }, [bar(afterPct, r.targetPct, beforePct)]),
      valueEl,
    ]);
  }

  function renderResult(plan: RebalancePlan, cashEur: Decimal): void {
    let buys = ZERO;
    let sells = ZERO;
    let totalAfter = ZERO;
    for (const r of plan.rows) {
      if (r.addValue.greaterThan(0)) buys = buys.plus(r.addValue);
      else if (r.addValue.lessThan(0)) sells = sells.plus(r.addValue.negated());
      totalAfter = totalAfter.plus(r.currentValue.plus(r.addValue));
    }
    const afterPct = (v: Decimal): Decimal => (totalAfter.greaterThan(0) ? v.times(100).dividedBy(totalAfter) : ZERO);

    const kpis: HTMLElement[] = [
      h("div", { class: "stat" }, [
        h("span", { class: "stat-label" }, ["Investing"]),
        h("span", { class: "stat-value" }, [fmt(cashEur)]),
      ]),
      h("div", { class: "stat" }, [
        h("span", { class: "stat-label" }, ["Buying"]),
        h("span", { class: "stat-value pos" }, [fmt(buys)]),
      ]),
    ];
    if (sells.greaterThan(0)) {
      kpis.push(
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label" }, ["Selling"]),
          h("span", { class: "stat-value neg" }, [fmt(sells)]),
        ]),
      );
    }
    kpis.push(
      h("div", { class: "stat" }, [
        h("span", { class: "stat-label" }, ["Left over"]),
        h("span", { class: "stat-value" }, [fmt(plan.residualCash)]),
      ]),
    );

    const heading = allowSell ? "Rebalance plan" : "Buy plan";
    const planNodes: HTMLElement[] = [];
    if (mode === "category") {
      const groups = new Map<string, RebalanceRow[]>();
      for (const r of plan.rows) {
        const cat = categoryOf.get(r.symbol) ?? UNCATEGORIZED;
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat)!.push(r);
      }
      const buyOf = (rows: RebalanceRow[]): Decimal =>
        rows.reduce((acc, r) => (r.addValue.greaterThan(0) ? acc.plus(r.addValue) : acc), ZERO);
      const ordered = [...groups.entries()].sort((a, b) => buyOf(b[1]).comparedTo(buyOf(a[1])));
      for (const [category, rows] of ordered) {
        let targetPct = ZERO;
        let beforeValue = ZERO;
        let afterValue = ZERO;
        let addValue = ZERO;
        let currentPct = ZERO;
        for (const r of rows) {
          targetPct = targetPct.plus(r.targetPct);
          beforeValue = beforeValue.plus(r.currentValue);
          afterValue = afterValue.plus(r.currentValue.plus(r.addValue));
          addValue = addValue.plus(r.addValue);
          currentPct = currentPct.plus(currentPctOf.get(r.symbol) ?? ZERO);
        }
        let headValue: HTMLElement;
        if (addValue.greaterThan(0)) headValue = h("span", { class: "calc2-add pos" }, [`+ ${fmt(addValue)}`]);
        else if (addValue.lessThan(0)) headValue = h("span", { class: "calc2-add neg" }, [`- ${fmt(addValue.negated())} net`]);
        else headValue = h("span", { class: "calc2-add muted" }, ["no new cash"]);
        planNodes.push(
          h("div", { class: "calc2-plan-head" }, [
            h("div", { class: "calc2-row-label" }, [
              h("span", { class: "calc2-row-name" }, [category]),
              h("span", { class: "calc2-row-sub muted" }, [
                `now ${pct1(currentPct)} → ${pct1(afterPct(afterValue))} after · target ${pct1(targetPct)}`,
              ]),
            ]),
            h("div", { class: "calc2-bar-holder" }, [bar(afterPct(afterValue), targetPct, afterPct(beforeValue))]),
            headValue,
          ]),
        );
        for (const r of [...rows].sort((a, b) => b.addValue.comparedTo(a.addValue))) {
          planNodes.push(
            planRowEl(
              `${r.symbol} · ${nameOf.get(r.symbol) ?? r.symbol}`,
              r,
              afterPct(r.currentValue.plus(r.addValue)),
              afterPct(r.currentValue),
              true,
            ),
          );
        }
      }
    } else {
      for (const r of [...plan.rows].sort((a, b) => b.addValue.comparedTo(a.addValue))) {
        planNodes.push(
          planRowEl(
            `${r.symbol} · ${nameOf.get(r.symbol) ?? r.symbol}`,
            r,
            afterPct(r.currentValue.plus(r.addValue)),
            afterPct(r.currentValue),
            false,
          ),
        );
      }
    }

    resultBox.replaceChildren(
      h("section", { class: "card" }, [
        h("div", { class: "section-head" }, [h("h2", {}, ["Plan summary"])]),
        h("div", { class: "stat-grid calc2-summary" }, kpis),
      ]),
      h("section", { class: "card" }, [
        h("div", { class: "section-head" }, [h("h2", {}, [heading])]),
        h("div", { class: "calc2-plan" }, planNodes),
      ]),
    );
    resultBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // --- Controls ---
  const seedCashDisplay = ((): string => {
    const saved = loadStringPref(CALC2_CASH_EUR_KEY);
    if (saved === null) return "1000";
    try {
      return convertFromEur(new Decimal(saved)).value.toDecimalPlaces(0).toString();
    } catch {
      return "1000";
    }
  })();
  const cashField = numberField(`Cash to invest (${code})`, seedCashDisplay, { min: "0", step: "10" });
  const cashInput = cashField.input;
  cashInput.addEventListener("input", () => {
    clearNotice();
    try {
      const amount = new Decimal(cashInput.value || 0);
      saveStringPref(CALC2_CASH_EUR_KEY, (isUsd ? convertToEur(amount) : amount).toString());
    } catch {
      /* Ignore an unparseable interim value; it saves on the next keystroke. */
    }
  });

  const fractionalCb = h("input", { type: "checkbox", id: "calc2-fractional" }) as HTMLInputElement;
  fractionalCb.checked = fractional;
  fractionalCb.addEventListener("change", () => {
    fractional = fractionalCb.checked;
    saveBoolPref(CALC_FRACTIONAL_KEY, fractional);
  });
  const rebalanceCb = h("input", { type: "checkbox", id: "calc2-rebalance" }) as HTMLInputElement;
  rebalanceCb.checked = allowSell;
  rebalanceCb.addEventListener("change", () => {
    allowSell = rebalanceCb.checked;
    saveBoolPref(CALC_REBALANCE_KEY, allowSell);
  });

  const modeToggle = makeModeToggle((m) => {
    mode = m;
    saveStringPref(CALC2_MODE_KEY, m);
    renderBuilder();
  });
  // Reflect the remembered mode on the toggle (it defaults to "category").
  if (mode === "fund") modeToggle.select("fund");

  const presetRow = h("div", { class: "calc2-presets" }, [
    presetBtn("Match current mix", presetCurrent),
    presetBtn("Equal weight", presetEqual),
    presetBtn("Clear", presetClear),
  ]);
  if (data.savedTargets.length > 0) {
    const select = h("select", { class: "calc2-saved-select", "aria-label": "Load a saved target" }, [
      h("option", { value: "" }, ["Load saved target…"]),
      ...data.savedTargets.map((t, i) =>
        h("option", { value: String(i) }, [t.active ? `${t.name} (active)` : t.name]),
      ),
    ]) as HTMLSelectElement;
    select.addEventListener("change", () => {
      const idx = Number(select.value);
      if (select.value !== "" && data.savedTargets[idx]) loadSaved(data.savedTargets[idx]);
      select.value = "";
    });
    presetRow.append(select);
  }

  const computeBtn = h("button", { class: "btn-primary calc2-compute", type: "button" }, ["Compute plan"]);
  computeBtn.addEventListener("click", compute);

  renderSummary();
  renderBuilder();

  // Auto-load the active saved target on open (parity with the desktop), so the
  // user's last-saved mix is ready immediately — no manual "Load" needed. The
  // dropdown above stays available to re-apply it after tweaks or to pick another.
  const activeSaved = data.savedTargets.find((t) => t.active);
  if (activeSaved) loadSaved(activeSaved);

  return h("section", { class: "panel-stack panel-calc2" }, [
    h("section", { class: "card" }, [
      h("div", { class: "section-head" }, [
        h("h2", {}, ["Calculator"]),
        h("span", { class: "muted" }, ["how much to invest"]),
      ]),
      h("p", { class: "note" }, [
        "Build a target mix and turn a contribution into a concrete buy-only plan. " +
          "Set a target % per row — totals are normalised to 100% when you compute.",
      ]),
    ]),
    summaryBox,
    h("section", { class: "card" }, [
      h("div", { class: "section-head" }, [h("h2", {}, ["1 · How much are you investing?"])]),
      h("div", { class: "calc2-cash" }, [
        cashField.wrap,
        h("label", { class: "calc2-check" }, [fractionalCb, " Allow fractional shares"]),
        h("label", { class: "calc2-check" }, [rebalanceCb, " Rebalance (allow selling)"]),
      ]),
    ]),
    h("section", { class: "card" }, [
      h("div", { class: "section-head" }, [h("h2", {}, ["2 · Set your target mix"])]),
      h("div", { class: "calc2-controls" }, [modeToggle.el, presetRow]),
      h("div", { class: "calc2-total" }, [totalBar, totalLabel]),
      builderBox,
      noticeBox,
      h("div", { class: "calc2-actions" }, [computeBtn]),
    ]),
    resultBox,
    h("p", { class: "disclaimer" }, [
      "Plans assume your live prices and are share-level estimates, not orders or financial advice.",
    ]),
  ]);
}

/** A small two/three-option pill toggle returning a setter to select a value. */
function makeMiniToggle(
  options: { value: string; label: string }[],
  initial: string,
  onChange: (value: string) => void,
): HTMLElement {
  const buttons: HTMLButtonElement[] = [];
  const el = h("div", { class: "calc2-minitoggle", role: "group" }, []);
  for (const opt of options) {
    const btn = h("button", { class: "calc2-pill", type: "button" }, [opt.label]) as HTMLButtonElement;
    if (opt.value === initial) btn.classList.add("active");
    btn.addEventListener("click", () => {
      for (const b of buttons) b.classList.remove("active");
      btn.classList.add("active");
      onChange(opt.value);
    });
    buttons.push(btn);
    el.append(btn);
  }
  return el;
}

/** The category/fund mode toggle, exposing a `select` so presets can sync it. */
function makeModeToggle(onChange: (mode: "category" | "fund") => void): {
  el: HTMLElement;
  select: (mode: "category" | "fund") => void;
} {
  const options: { value: "category" | "fund"; label: string }[] = [
    { value: "category", label: "By category" },
    { value: "fund", label: "By fund" },
  ];
  const buttons = new Map<string, HTMLButtonElement>();
  const el = h("div", { class: "calc2-minitoggle", role: "group", "aria-label": "Target mode" }, []);
  const select = (mode: "category" | "fund"): void => {
    for (const [v, b] of buttons) b.classList.toggle("active", v === mode);
  };
  for (const opt of options) {
    const btn = h("button", { class: "calc2-pill", type: "button" }, [opt.label]) as HTMLButtonElement;
    if (opt.value === "category") btn.classList.add("active");
    btn.addEventListener("click", () => {
      select(opt.value);
      onChange(opt.value);
    });
    buttons.set(opt.value, btn);
    el.append(btn);
  }
  return { el, select };
}

/** A flat text button used for the calculator presets. */
function presetBtn(label: string, onClick: () => void): HTMLButtonElement {
  const btn = h("button", { class: "calc2-preset", type: "button" }, [label]) as HTMLButtonElement;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * Self-contained colour-theme toggle. Cycles System → Light → Dark and updates
 * its own glyph/label in place, so both the live dashboard and demo share it
 * without threading state through the controller.
 */
export function renderThemeToggle(): HTMLElement {
  const glyph = h("span", { class: "icon-btn-glyph", "aria-hidden": "true" }, []);
  const text = h("span", { class: "icon-btn-text" }, []);
  const button = h("button", { class: "icon-btn ghost", type: "button", "data-action": "theme" }, [glyph, text]);

  const sync = (): void => {
    const { glyph: g, label } = themeButtonContent(loadTheme());
    glyph.textContent = g;
    text.textContent = label;
    button.setAttribute("aria-label", `Theme: ${label} (tap to change)`);
    button.setAttribute("title", `Theme: ${label}`);
  };
  sync();
  button.addEventListener("click", () => {
    cycleTheme();
    sync();
  });
  return button;
}

/**
 * Self-contained clock-format toggle (Auto / 12h / 24h). Like the theme toggle,
 * it persists its own choice and updates its label in place; the new clock takes
 * effect the next time the dashboard renders (e.g. on returning from Settings).
 */
export function renderTimeFormatToggle(): HTMLElement {
  const labels: Record<TimeFormat, string> = {
    auto: "Auto (locale)",
    "12h": "12-hour (AM/PM)",
    "24h": "24-hour",
  };
  const select = h("select", { class: "select", "data-action": "time-format" }, [
    h("option", { value: "auto" }, [labels.auto]),
    h("option", { value: "12h" }, [labels["12h"]]),
    h("option", { value: "24h" }, [labels["24h"]]),
  ]) as HTMLSelectElement;
  select.value = getTimeFormat();
  select.setAttribute("aria-label", "Clock format");
  select.addEventListener("change", () => {
    setTimeFormat((select.value as TimeFormat) || "auto");
  });
  return select;
}

/**
 * Persisted opt-in for the optional extra (3M / 6M) chart ranges. Live **1D** and
 * **1W** plus the `1M` / `1Y` slices are always shown; turning this on adds the
 * longer `3M` and `6M` history slices back to the value chart's range strip. Off
 * by default for a cleaner look.
 */
const EXTENDED_GRAPHS_KEY = "iv.web.extendedGraphs";

/** Whether the optional 3M / 6M chart ranges are currently enabled. */
export function extendedGraphsEnabled(): boolean {
  return loadBoolPref(EXTENDED_GRAPHS_KEY, false);
}

/**
 * Self-contained toggle for the optional 3M / 6M chart ranges. Persists its own
 * choice; the change takes effect the next time the dashboard renders (e.g. on
 * returning from Settings), exactly like the theme and clock toggles.
 */
export function renderExtendedGraphsToggle(): HTMLElement {
  const select = h("select", { class: "select", "data-action": "extended-graphs" }, [
    h("option", { value: "0" }, ["Off — 1D · 1W · 1M · 1Y"]),
    h("option", { value: "1" }, ["On — also 3M & 6M"]),
  ]) as HTMLSelectElement;
  select.value = extendedGraphsEnabled() ? "1" : "0";
  select.setAttribute("aria-label", "Extra chart ranges");
  select.addEventListener("change", () => {
    saveBoolPref(EXTENDED_GRAPHS_KEY, select.value === "1");
  });
  return select;
}

/**
 * EUR ↔ USD display-currency toggle. The compute layer denominates figures in
 * EUR as its internal FX-pivot (USD is the native booked currency); flipping
 * this re-renders the whole dashboard (via `onToggle`) so every figure reformats
 * in the chosen currency. Disabled when no EUR→USD rate is available.
 */
function renderCurrencyToggle(onToggle: () => void): HTMLElement {
  const glyph = h("span", { class: "icon-btn-glyph", "aria-hidden": "true" }, []);
  const text = h("span", { class: "icon-btn-text" }, []);
  const button = h("button", { class: "icon-btn ghost", type: "button", "data-action": "currency" }, [glyph, text]);

  const sync = (): void => {
    const active: DisplayCurrency = getDisplayCurrency();
    glyph.textContent = active === "USD" ? "$" : "€";
    text.textContent = active;
    button.setAttribute("aria-label", `Currency: ${active} (tap to switch)`);
    button.setAttribute("title", `Showing ${active} — tap to switch`);
  };
  sync();

  if (!canConvertToUsd() && getDisplayCurrency() === "EUR") {
    button.setAttribute("disabled", "disabled");
    button.setAttribute("title", "EUR→USD rate unavailable");
  }

  button.addEventListener("click", () => {
    toggleDisplayCurrency();
    onToggle();
  });
  return button;
}
