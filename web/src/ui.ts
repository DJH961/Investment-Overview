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
import type { AllocationSlice, DashboardModel, HoldingView, OverviewView } from "./compute";
import { fxTodayDeviationPct } from "./compute";
import {
  type AnalyticsView,
  type DepositRowView,
  type DepositsView,
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
  formatCurrencyWhole,
  formatDualCurrency,
  formatFxRate,
  formatMoneyEur,
  formatNativePrice,
  formatPercent,
  formatShares,
  formatSignedCurrency,
  formatSignedDualCurrency,
  formatSignedMoneyEur,
  formatSignedPercent,
  formatTimestamp,
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

/** The headline portfolio value + today's move — the hero of the screen. */
function renderHero(o: OverviewView, now: Date = new Date()): HTMLElement {
  // Today's move is currency-correct: in USD display we prefer the USD figures so
  // the headline daily change reflects the dollar view, not the EUR view rescaled.
  const todayMovePct = pickByCurrency(o.todayMovePct, o.todayMovePctUsd);
  const cls = signClass(pickByCurrency(o.todayMoveEur, o.todayMoveUsd));
  const change = h("div", { class: `hero-change ${cls}` }, [
    h("span", { class: "hero-badge" }, [
      h("span", { class: "hero-arrow", "aria-hidden": "true" }, [trendGlyph(cls)]),
      formatSignedDualCurrency(o.todayMoveEur, o.todayMoveUsd),
    ]),
    h("span", { class: "hero-change-pct" }, [
      todayMovePct !== null ? `${formatSignedPercent(todayMovePct)} today` : "today",
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
  const fxLine = renderHeroFx(o);
  if (fxLine) children.push(fxLine);
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
 * The live FX context under today's move: the current spot and how far it has
 * moved today (the % deviation), plus an honest "end-of-day FX" tag when only
 * the ECB daily rate was available. Both display currencies show the rate from
 * the user's own side as a "spend my currency, get the other" conversion: USD
 * display quotes USD/EUR (how much EUR one dollar buys), EUR display quotes the
 * reciprocal EUR/USD (how much USD one euro buys). The percentage tracks the
 * strength of the *foreign* currency you'd convert into — euro in USD display,
 * dollar in EUR display — so a positive figure always means "that currency went
 * up". This is deliberately counter-intuitive against the rate number (which
 * moves the opposite way), because it answers "did the euro or the dollar rise?"
 * rather than "did this digit go up?". We do *not* print any "how much the swing
 * made you in EUR" money line — the FX P/L slice lives in the Risk tab's currency
 * panel, not on the hero. Returns null when there's no rate to show.
 */
function renderHeroFx(o: OverviewView): HTMLElement | null {
  const inUsd = getDisplayCurrency() === "USD";
  const parts: HTMLElement[] = [];
  if (o.fxRateEurUsd !== null) {
    // The spot rate, plus how far the FX moved today. The stored spot is EUR/USD
    // (USD per 1 EUR), and `devPct` is the euro's move. In USD display we invert
    // the rate to USD/EUR (EUR per 1 USD); the percentage keeps the euro's sign
    // so "+" = euro stronger. In EUR display we show EUR/USD as-is but negate the
    // percentage so it reads the dollar's strength, "+" = dollar stronger.
    // Example: EUR/USD 1.07 → 1.08 (euro up). USD display shows USD/EUR ticking
    // *down* (0.9346 → 0.9259) yet a +% because the euro strengthened.
    const devPct = fxTodayDeviationPct(o);
    const rate = inUsd ? new Decimal(1).dividedBy(o.fxRateEurUsd) : o.fxRateEurUsd;
    const dev = devPct === null ? null : inUsd ? devPct : devPct.negated();
    const pair = inUsd ? "USD/EUR" : "EUR/USD";
    const rateLabel =
      dev !== null
        ? `${pair} ${formatFxRate(rate)} (${formatSignedPercent(dev)} today)`
        : `${pair} ${formatFxRate(rate)}`;
    parts.push(h("span", { class: "hero-fx-rate" }, [rateLabel]));
  }
  if (o.eurUsdSource === "eod") {
    parts.push(h("span", { class: "hero-fx-eod" }, ["end-of-day FX"]));
  }
  if (parts.length === 0) return null;
  return h("div", { class: "hero-fx" }, parts);
}

/** One return horizon (Today / This month / This year). */
function segment(label: string, value: Decimal | null): HTMLElement {
  return h("div", { class: "segment-item" }, [
    h("span", { class: "segment-label" }, [label]),
    h("span", { class: `segment-value ${signClass(value)}` }, [signedPercentOrDash(value)]),
  ]);
}

/** Today / month / year return horizons, side by side. */
function renderReturns(o: OverviewView): HTMLElement {
  return h("section", { class: "segment", "aria-label": "Return by period" }, [
    segment("Today", pickByCurrency(o.todayMovePct, o.todayMovePctUsd)),
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
  const totalGainPct = pickByCurrency(o.totalGainPct, o.totalGainPctUsd);
  const totalGrowthCompounded = pickByCurrency(
    o.totalGrowthCompoundedPct,
    o.totalGrowthCompoundedPctUsd,
  );
  const xirr = pickByCurrency(o.portfolioXirr, o.portfolioXirrUsd);
  const gainPicked = pickByCurrency(o.totalGainEur, o.totalGainUsd);
  const grid = h("div", { class: "stat-grid" }, [
    stat(
      "Total gain",
      formatSignedDualCurrency(o.totalGainEur, o.totalGainUsd),
      signClass(gainPicked),
      totalGainPct !== null ? formatSignedPercent(totalGainPct) : undefined,
    ),
    stat(
      "Total growth",
      signedPercentOrDash(totalGrowthCompounded),
      signClass(totalGrowthCompounded),
    ),
    stat("XIRR", formatPercent(xirr), signClass(xirr)),
    stat("Div. yield", o.dividendYieldPct !== null ? formatPercent(o.dividendYieldPct) : "—"),
    stat("Invested", formatDualCurrency(o.totalCostBasisEur, o.totalCostBasisUsd)),
    stat("Cash & savings", formatCurrency(o.cashValueEur)),
  ]);
  return h("section", { class: "stats" }, [grid, ...renderNotes(o)]);
}

/**
 * A short provenance tag for the EUR→USD rate shown on the coverage line:
 * "(live)" for the intraday Twelve Data spot, "(cached)" for a recently-stored
 * live spot reused without a re-fetch (so a quick app re-open stays instant),
 * "(end-of-day)" for the ECB daily fallback, and nothing for an export rate.
 */
function fxSourceTag(o: OverviewView): string {
  if (o.eurUsdSource === "live") return " (live)";
  if (o.eurUsdSource === "cache") return " (cached)";
  if (o.eurUsdSource === "eod") return " (end-of-day)";
  return "";
}

function renderNotes(o: OverviewView): HTMLElement[] {
  const notes: HTMLElement[] = [];
  // Lead with the live-coverage line: a calm, descriptive "how much is fresh"
  // status. The live FX spot rides along here (prioritised over the ECB
  // end-of-day rate) so the single most-watched live number sits with the
  // freshness summary rather than reflowing a separate line below. It is quoted
  // from the display currency's side (EUR→USD in USD display, the reciprocal
  // USD→EUR in EUR display) so it matches the hero's inverted FX line.
  const coverageParts: string[] = [];
  if (o.liveCoverage) coverageParts.push(o.liveCoverage);
  if (o.fxRateEurUsd !== null) {
    const inUsd = getDisplayCurrency() === "USD";
    const rate = inUsd ? o.fxRateEurUsd : new Decimal(1).dividedBy(o.fxRateEurUsd);
    const pair = inUsd ? "EUR→USD" : "USD→EUR";
    coverageParts.push(`${pair} ${formatFxRate(rate)}${fxSourceTag(o)}`);
  }
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
  if (o.fxRateEurUsd !== null) {
    notes.push(
      h("p", { class: "note" }, [
        `Dividends ${formatCurrency(o.totalDividendsEur)} to date.`,
      ]),
    );
  }
  notes.push(
    h("p", { class: "note" }, [
      `Data exported ${formatTimestamp(o.generatedAt)} · data last pulled ${formatLastPull(o.lastDataPullAt)}.`,
    ]),
  );
  if (o.dailyCreditsUsed !== null) {
    notes.push(
      h("p", { class: "note" }, [
        `Live-data budget today: ${o.dailyCreditsUsed} / ${o.dailyCreditLimit} credits used.`,
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
  return h("details", { class: "allocation" }, [
    h("summary", { class: "alloc-summary" }, [
      h("span", { class: "alloc-summary-title" }, ["Allocation"]),
      h("span", { class: "muted" }, ["by asset class"]),
    ]),
    h("ul", { class: "alloc-list" }, rows),
  ]);
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

/** A single holding as a list row (mobile-first, no wide horizontal table). */
function renderHoldingRow(holding: HoldingView): HTMLElement {
  const symChildren: Array<Node | string> = [holding.symbol];
  if (holding.priceType === "nav") symChildren.push(h("span", { class: "pill" }, ["NAV"]));
  // A genuinely stale fallback (no price at all) is still flagged; the milder
  // "price came from the export" case is conveyed by the "as of" date/time below
  // rather than a vague "last known" bubble.
  if (holding.valueIsStale) {
    symChildren.push(h("span", { class: "pill stale" }, ["stale value"]));
  }

  const todayPct = pickByCurrency(holding.todayMovePct, holding.todayMovePctUsd);
  const todayCls = signClass(todayPct);
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
      h("span", { class: `holding-change ${todayCls}` }, [signedPercentOrDash(todayPct)]),
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

function renderHoldings(holdings: HoldingView[]): HTMLElement {
  const sorted = [...holdings].sort((a, b) => {
    const av = a.valueEur?.toNumber() ?? -1;
    const bv = b.valueEur?.toNumber() ?? -1;
    return bv - av;
  });
  const count = `${holdings.length} ${holdings.length === 1 ? "position" : "positions"}`;
  const list = h("ul", { class: "holding-list" }, sorted.map(renderHoldingRow));
  return collapsibleSection("Holdings", count, list, "holdings");
}

export function renderDashboard(
  model: DashboardModel,
  onRefresh: () => void,
  onLock: () => void,
  onToggleCurrency: () => void,
  onSettings: () => void,
  lockLabel = "Lock",
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
      ]),
      h("div", { class: "topbar-actions" }, [currency, refresh, settings, lock]),
    ]),
  ]);

  // Each tab is a self-contained panel; the nav just toggles which is visible
  // (no re-render, so live figures and form state survive a tab switch).
  const tabs: TabDef[] = [
    { id: "overview", label: "Overview", glyph: "◎", panel: renderOverviewPanel(model) },
    { id: "periods", label: "Periods", glyph: "▦", panel: renderPeriodsPanel(model.periods, model.deposits, model.plan) },
    { id: "analytics", label: "Risk", glyph: "📈", panel: renderAnalyticsPanel(model.analytics, model.overview, model.deposits) },
    { id: "plan", label: "Calculator", glyph: "🧮", panel: renderCalculatorPanel(model.plan) },
  ];

  const { nav, content } = renderTabs(tabs);
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
function renderTabs(tabs: TabDef[]): { nav: HTMLElement; content: HTMLElement } {
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
  // toggle re-render); default to the first tab when none is remembered.
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
function renderOverviewPanel(model: DashboardModel): HTMLElement {
  const content: Array<Node | string> = [
    renderHero(model.overview),
    renderReturns(model.overview),
  ];
  const valueChart = renderValueChart(model.analytics, model.overview);
  if (valueChart) content.push(valueChart);
  content.push(renderStats(model.overview), renderHoldings(model.holdings));
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
  const statGrid = h("div", { class: "stat-grid" }, [
    stat("Contributed", formatDualCurrency(deposits.totalEur, deposits.totalUsd)),
    stat("This year", formatDualCurrency(deposits.ytdEur, deposits.ytdUsd)),
    stat("This month", formatDualCurrency(deposits.mtdEur, deposits.mtdUsd)),
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
      return h("details", { class: "allocation year-contribs" }, [
        h("summary", { class: "alloc-summary" }, [
          h("span", { class: "alloc-summary-title" }, [yr]),
          h("span", { class: "muted" }, [`${rows.length} contribution${rows.length === 1 ? "" : "s"}`]),
        ]),
        h("ul", { class: "ledger-list" }, rows.map(renderDepositRow)),
      ]);
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
    h("span", { class: "ledger-amount" }, [formatDualCurrency(row.amountEur, row.amountUsd)]),
  ]);
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
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (canHover) return;
    const wasOpen = button === openInfoDot;
    closeOpenInfoDot();
    if (!wasOpen) {
      button.classList.add("open");
      openInfoDot = button;
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

/**
 * A line chart wrapped with time-range presets. Builds the full chart, then —
 * when there is enough history to make a shorter window meaningful — adds a
 * small button group that re-slices the same series to the chosen look-back and
 * redraws in place (no re-fetch; purely a view of the already-loaded points).
 */
function chartWithTimeframe(
  dates: string[],
  series: ChartSeries[],
  chartOpts: { yAxisLabel?: (v: number) => string } = {},
): HTMLElement | null {
  const full = buildLineChart({ dates, series, ...chartOpts });
  if (!full) return null;
  const wrap = h("div", { class: "chart-wrap" }, [full as unknown as HTMLElement]);

  const span = dates.length >= 2 ? daysBetween(dates[0], dates[dates.length - 1]) : 0;
  const presets = CHART_TIMEFRAMES.filter((t) => span > t.days + 5);
  // Nothing worth toggling (history shorter than the smallest preset): plain chart.
  if (presets.length === 0) return wrap;
  const options: Array<{ label: string; days: number | null }> = [...presets, { label: "All", days: null }];

  const lastMs = Date.parse(dates[dates.length - 1]);
  const buttons: HTMLButtonElement[] = [];

  const apply = (days: number | null, index: number): void => {
    let start = 0;
    if (days !== null) {
      const cutoff = lastMs - days * 86_400_000;
      start = dates.findIndex((d) => Date.parse(d) >= cutoff);
      if (start < 0) start = 0;
      // Always keep at least two points so the chart can still draw a line.
      if (dates.length - start < 2) start = Math.max(0, dates.length - 2);
    }
    const slicedDates = dates.slice(start);
    const slicedSeries = series.map((s) => ({ ...s, values: s.values.slice(start) }));
    const chart = buildLineChart({ dates: slicedDates, series: slicedSeries, ...chartOpts });
    if (chart) wrap.replaceChildren(chart as unknown as HTMLElement);
    buttons.forEach((button, i) => {
      const active = i === index;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };

  const controls = h("div", { class: "chart-range", role: "group", "aria-label": "Chart time range" }, []);
  options.forEach((option, index) => {
    const button = h("button", { class: "chart-range-btn", type: "button" }, [option.label]) as HTMLButtonElement;
    button.addEventListener("click", () => apply(option.days, index));
    buttons.push(button);
    controls.appendChild(button);
  });
  // Default to the full history (the last option).
  apply(null, options.length - 1);

  return h("div", { class: "chart-block" }, [controls, wrap]);
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
export function rebaseBenchmark(points: AnalyticsView["curve"]): Array<Decimal | null> {
  const anchorBench = points.find((p) => p.benchmarkValue !== null)?.benchmarkValue ?? null;
  const anchorPortfolio =
    points.find((p) => p.portfolioValue !== null && p.portfolioValue.greaterThan(0))?.portfolioValue ?? null;
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
 * The Risk-tab equity curve: portfolio value vs. the cumulative-contributions
 * baseline and (when present) the benchmark, drawn with the shared axis-aware
 * line chart. Stamped as-of-export — history-bound, it does not move intraday.
 */
function renderEquityCurve(curve: AnalyticsView["curve"], benchmarkSymbol: string | null): HTMLElement | null {
  const points = curve.filter((p) => p.portfolioValue !== null);
  if (points.length < 2) return null;

  const dates = points.map((p) => p.date);
  const series: ChartSeries[] = [
    { values: points.map((p) => p.portfolioValue), className: "series-portfolio", area: true },
  ];
  const hasContribs = points.some((p) => p.contributions !== null);
  if (hasContribs) {
    series.push({ values: points.map((p) => p.contributions), className: "series-contrib" });
  }
  const hasBenchmark = points.some((p) => p.benchmarkValue !== null);
  if (hasBenchmark) {
    series.push({ values: rebaseBenchmark(points), className: "series-benchmark" });
  }

  const chart = chartWithTimeframe(dates, series);
  if (!chart) return null;

  const legend: Array<Node | string> = [legendItem("series-portfolio", "Portfolio")];
  if (hasContribs) legend.push(legendItem("series-contrib", "Contributions"));
  if (hasBenchmark) legend.push(legendItem("series-benchmark", benchmarkSymbol ?? "Benchmark"));

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
  const dd = computeDrawdownSeries(curve);
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

  const chart = chartWithTimeframe(dates, [{ values, className: "series-drawdown", area: true }], { yAxisLabel: pctLabel });
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
 * The Overview "value over time" graph. Reuses the exported equity curve and
 * appends today's live total value as the final point, so the headline figure
 * is the tip of the line. Returns null when no usable history was exported.
 */
function renderValueChart(analytics: AnalyticsView | null, o: OverviewView): HTMLElement | null {
  if (analytics === null) return null;
  const points = analytics.curve.filter((p) => p.portfolioValue !== null);
  if (points.length < 1) return null;

  const dates = points.map((p) => p.date);
  const values: Array<Decimal | null> = points.map((p) => p.portfolioValue);

  // Append today's live total as the latest point when it is newer than the
  // last exported point, so the curve runs right up to "today" — but only when
  // the live total is complete. If some holdings could not be valued live (no
  // price or no FX rate) they fall out of the sum, so the tip would under-count
  // the portfolio and draw a false dip; in that case stop at the last
  // fully-valued exported point.
  const lastDate = dates[dates.length - 1];
  if (o.totalValueIsComplete) {
    if (o.asOf > lastDate) {
      dates.push(o.asOf);
      values.push(o.totalValueEur);
    } else if (o.asOf === lastDate) {
      values[values.length - 1] = o.totalValueEur;
    }
  }
  if (values.filter((v) => v !== null).length < 2) return null;

  const chart = chartWithTimeframe(dates, [{ values, className: "series-portfolio", area: true }]);
  if (!chart) return null;

  const todayPct = pickByCurrency(o.todayMovePct, o.todayMovePctUsd);
  const cls = signClass(pickByCurrency(o.todayMoveEur, o.todayMoveUsd));
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
      h("span", { class: `muted ${cls}` }, [
        todayPct !== null ? `${formatSignedPercent(todayPct)} today` : "today",
      ]),
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
  // The horizon default is yearly (10 years / 120 months).
  let monthly = false;
  const seedYearlyContrib = convertFromEur(plan.defaultAnnualContributionEur);
  const seedMonthlyContrib = convertFromEur(plan.defaultMonthlyContributionEur);
  const code = seedYearlyContrib.code;

  const getDefaultContrib = (): string =>
    monthly
      ? seedMonthlyContrib.value.toDecimalPlaces(0).toString()
      : seedYearlyContrib.value.toDecimalPlaces(0).toString();

  // --- Controls ---
  const expectedRate = numberField(`Expected return % p.a.`, seedRatePct, { min: "-50", max: "40", step: "0.1" });
  const band = numberField("± band (pp)", "3.0", { min: "0", max: "30", step: "0.5" });
  const contribution = numberField(
    `Contribution / ${monthly ? "month" : "year"} (${code})`,
    getDefaultContrib(),
    { min: "0", step: "10" },
  );
  const contribLabel = contribution.wrap.querySelector(".field-label");
  const stepUp = numberField("Annual step-up %", "0", { min: "0", max: "100", step: "0.5" });
  const inflation = numberField("Inflation %", "2.0", { min: "0", max: "30", step: "0.1" });
  const target = numberField(`Target value (${code})`, "0", { min: "0", step: "1000" });

  // Horizon: years (1–40) or months (1–480), default 10y / 120m.
  const horizonInput = numberField("Horizon (years)", "10", { min: "1", max: "40", step: "1" });
  const horizonLabel = horizonInput.wrap.querySelector(".field-label");

  // Period toggle (yearly / monthly).
  const btnYearly = h("button", { class: "chart-range-btn active", type: "button" }, ["Yearly"]) as HTMLButtonElement;
  const btnMonthly = h("button", { class: "chart-range-btn", type: "button" }, ["Monthly"]) as HTMLButtonElement;
  btnYearly.setAttribute("aria-pressed", "true");
  btnMonthly.setAttribute("aria-pressed", "false");

  // "Today's money" (real / nominal) toggle.
  const realToggleInput = h("input", { type: "checkbox", id: "calc-real" }) as HTMLInputElement;
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
    btnYearly.classList.toggle("active", !monthly);
    btnMonthly.classList.toggle("active", monthly);
    btnYearly.setAttribute("aria-pressed", monthly ? "false" : "true");
    btnMonthly.setAttribute("aria-pressed", monthly ? "true" : "false");
    horizonInput.input.max = monthly ? "480" : "40";
    horizonInput.input.value = monthly ? "120" : "10";
    if (horizonLabel) horizonLabel.textContent = monthly ? "Horizon (months)" : "Horizon (years)";
    if (contribLabel) contribLabel.textContent = `Contribution / ${monthly ? "month" : "year"} (${code})`;
    contribution.input.value = getDefaultContrib();
    recompute();
  };

  btnYearly.addEventListener("click", () => switchMode(false));
  btnMonthly.addEventListener("click", () => switchMode(true));

  // Wire all inputs to recompute.
  for (const field of [expectedRate, band, contribution, stepUp, inflation, target, horizonInput]) {
    field.input.addEventListener("input", recompute);
  }
  realToggleInput.addEventListener("change", recompute);

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
 * The standalone Calculator tab: the projection engine arranged as form on the
 * left, KPI summary + goal + table on the right (see {@link buildCalculator}).
 */
function renderCalculatorPanel(plan: PlanView): HTMLElement {
  const { form, kpiOut, goalOut, tableOut } = buildCalculator(plan);
  return h("section", { class: "panel-stack panel-calc" }, [
    form,
    kpiOut,
    goalOut,
    tableOut,
    h("p", { class: "disclaimer" }, [
      "Projections are hypothetical, assume constant returns, and are not financial advice. Real markets vary year to year.",
    ]),
  ]);
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
