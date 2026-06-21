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
import {
  type AnalyticsView,
  type DepositsView,
  type PeriodRowView,
  type PeriodsView,
  type PlanView,
  type RiskMetric,
  projectForward,
  PROJECTION_SCENARIOS,
} from "./phase4";
import {
  formatCurrency,
  formatNativePrice,
  formatPercent,
  formatShares,
  formatSignedCurrency,
  formatSignedPercent,
  formatTimestamp,
  signClass,
} from "./format";
import { cycleTheme, loadTheme, themeButtonContent } from "./theme";
import {
  canConvertToUsd,
  getDisplayCurrency,
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
function renderHero(o: OverviewView): HTMLElement {
  const cls = signClass(o.todayMoveEur);
  const change = h("div", { class: `hero-change ${cls}` }, [
    h("span", { class: "hero-badge" }, [
      h("span", { class: "hero-arrow", "aria-hidden": "true" }, [trendGlyph(cls)]),
      formatSignedCurrency(o.todayMoveEur),
    ]),
    h("span", { class: "hero-change-pct" }, [
      o.todayMovePct !== null ? `${formatSignedPercent(o.todayMovePct)} today` : "today",
    ]),
  ]);

  return h("section", { class: "hero" }, [
    h("span", { class: "hero-label" }, ["Total value"]),
    h("span", { class: "hero-value" }, [formatCurrency(o.totalValueEur)]),
    change,
  ]);
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
    segment("Today", o.todayMovePct),
    segment("This month", o.mtdGrowthPct),
    segment("This year", o.ytdGrowthPct),
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
  const grid = h("div", { class: "stat-grid" }, [
    stat(
      "Total gain",
      formatSignedCurrency(o.totalGainEur),
      signClass(o.totalGainEur),
      o.totalGainPct !== null ? formatSignedPercent(o.totalGainPct) : undefined,
    ),
    stat(
      "Total growth",
      signedPercentOrDash(o.totalGrowthCompoundedPct),
      signClass(o.totalGrowthCompoundedPct),
    ),
    stat("XIRR", formatPercent(o.portfolioXirr), signClass(o.portfolioXirr)),
    stat("Div. yield", o.dividendYieldPct !== null ? formatPercent(o.dividendYieldPct) : "—"),
    stat("Invested", formatCurrency(o.totalCostBasisEur)),
    stat("Cash & savings", formatCurrency(o.cashValueEur)),
  ]);
  return h("section", { class: "stats" }, [grid, ...renderNotes(o)]);
}

function renderNotes(o: OverviewView): HTMLElement[] {
  const notes: HTMLElement[] = [];
  if (o.missingPriceSymbols.length > 0) {
    notes.push(
      h("p", { class: "note warn" }, [
        `No live price for ${o.missingPriceSymbols.join(", ")} — showing the last known value.`,
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
        `FX EUR→USD ${o.fxRateEurUsd.toFixed(4)} · dividends ${formatCurrency(o.totalDividendsEur)} to date.`,
      ]),
    );
  }
  notes.push(
    h("p", { class: "note" }, [`Data exported ${formatTimestamp(o.generatedAt)} · live as of ${o.asOf}.`]),
  );
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

/** A single holding as a list row (mobile-first, no wide horizontal table). */
function renderHoldingRow(holding: HoldingView): HTMLElement {
  const symChildren: Array<Node | string> = [holding.symbol];
  if (holding.priceType === "nav") symChildren.push(h("span", { class: "pill" }, ["NAV"]));
  if (holding.priceNative !== null && !holding.priceIsLive) {
    symChildren.push(h("span", { class: "pill stale" }, ["last known"]));
  }

  const todayCls = signClass(holding.todayMovePct);
  const main = h("div", { class: "holding-main" }, [
    h("div", { class: "holding-id" }, [
      h("span", { class: "holding-sym" }, symChildren),
      h("span", { class: "holding-name" }, [holding.name]),
    ]),
    h("div", { class: "holding-figures" }, [
      h("span", { class: "holding-value" }, [formatCurrency(holding.valueEur)]),
      h("span", { class: `holding-change ${todayCls}` }, [signedPercentOrDash(holding.todayMovePct)]),
    ]),
  ]);

  const meta = h("div", { class: "holding-meta" }, [
    chip(
      holding.priceNative !== null
        ? `Px ${formatNativePrice(holding.priceNative, holding.nativeCurrency)}`
        : "Px —",
    ),
    chip(`${formatShares(holding.shares)} sh`),
    chip(holding.weight !== null ? `${formatPercent(holding.weight)} wt` : "— wt"),
    chip(`P/L ${formatSignedCurrency(holding.unrealisedPlEur)}`, signClass(holding.unrealisedPlEur)),
    chip(`XIRR ${formatPercent(holding.xirr)}`, signClass(holding.xirr)),
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
  return h("section", { class: "holdings" }, [
    h("div", { class: "section-head" }, [h("h2", {}, ["Holdings"]), h("span", { class: "muted" }, [count])]),
    h("ul", { class: "holding-list" }, sorted.map(renderHoldingRow)),
  ]);
}

export function renderDashboard(
  model: DashboardModel,
  onRefresh: () => void,
  onLock: () => void,
  onToggleCurrency: () => void,
  lockLabel = "Lock",
): HTMLElement {
  const refresh = h("button", { class: "icon-btn", type: "button", "data-action": "refresh" }, [
    h("span", { class: "icon-btn-glyph", "aria-hidden": "true" }, ["↻"]),
    h("span", { class: "icon-btn-text" }, ["Refresh"]),
  ]);
  const lock = h("button", { class: "icon-btn ghost", type: "button", "data-action": "lock" }, [lockLabel]);
  refresh.addEventListener("click", onRefresh);
  lock.addEventListener("click", onLock);

  const theme = renderThemeToggle();
  const currency = renderCurrencyToggle(onToggleCurrency);

  const topbar = h("header", { class: "topbar" }, [
    h("div", { class: "topbar-inner" }, [
      h("div", { class: "brand" }, [
        h("span", { class: "brand-mark", "aria-hidden": "true" }, []),
        h("span", { class: "brand-name" }, ["Investment Overview"]),
      ]),
      h("div", { class: "topbar-actions" }, [currency, theme, refresh, lock]),
    ]),
  ]);

  // Each tab is a self-contained panel; the nav just toggles which is visible
  // (no re-render, so live figures and form state survive a tab switch).
  const tabs: TabDef[] = [
    { id: "overview", label: "Overview", glyph: "◎", panel: renderOverviewPanel(model) },
    { id: "periods", label: "Periods", glyph: "▦", panel: renderPeriodsPanel(model.periods, model.deposits) },
    { id: "analytics", label: "Risk", glyph: "📈", panel: renderAnalyticsPanel(model.analytics) },
    { id: "plan", label: "Plan", glyph: "🧭", panel: renderPlanPanel(model.plan) },
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
  const savedIndex = Math.max(0, tabs.findIndex((t) => t.id === loadActiveTab()));
  select(savedIndex, false);
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
  const growthCls = signClass(row.growthPct);
  const badges: Array<Node | string> = [periodLabel(row.label)];
  if (row.isLive) badges.push(h("span", { class: "pill live" }, ["live"]));
  else if (row.isCurrent) badges.push(h("span", { class: "pill" }, ["current"]));

  const main = h("div", { class: "holding-main" }, [
    h("div", { class: "holding-id" }, [
      h("span", { class: "holding-sym" }, badges),
      h("span", { class: "holding-name" }, [
        row.closingValueEur !== null ? `Value ${formatCurrency(row.closingValueEur)}` : "Value —",
      ]),
    ]),
    h("div", { class: "holding-figures" }, [
      h("span", { class: `holding-value ${growthCls}` }, [signedPercentOrDash(row.growthPct)]),
      h("span", { class: "holding-change muted" }, ["growth"]),
    ]),
  ]);

  const meta = h("div", { class: "holding-meta" }, [
    chip(`Net flow ${formatSignedCurrency(row.netFlowEur)}`, signClass(row.netFlowEur)),
    chip(`Contrib ${formatCurrency(row.contributionsEur)}`),
    chip(`Div ${formatCurrency(row.dividendsEur)}`),
    chip(`Int ${formatCurrency(row.interestEur)}`),
  ]);

  return h("li", { class: "holding" }, [main, meta]);
}

function renderPeriodList(title: string, rows: PeriodRowView[], extraClass = ""): HTMLElement {
  const cls = `holdings ${extraClass}`.trim();
  if (rows.length === 0) {
    return h("section", { class: cls }, [sectionHead(title), h("p", { class: "note" }, ["No periods yet."])]);
  }
  return h("section", { class: cls }, [
    sectionHead(title, `${rows.length} ${rows.length === 1 ? "period" : "periods"}`),
    h("ul", { class: "holding-list" }, rows.map(renderPeriodRow)),
  ]);
}

function renderDepositsBlock(deposits: DepositsView): HTMLElement {
  const summary = h("div", { class: "stat-grid" }, [
    stat("Contributed", formatCurrency(deposits.totalEur)),
    stat("This year", formatCurrency(deposits.ytdEur)),
    stat("This month", formatCurrency(deposits.mtdEur)),
  ]);

  const recent = deposits.rows.slice(0, 12);
  const rows = recent.map((row) =>
    h("li", { class: "ledger-row" }, [
      h("div", { class: "ledger-id" }, [
        h("span", { class: "ledger-kind" }, [titleCase(row.kind)]),
        h("span", { class: "ledger-sub muted" }, [`${row.date} · ${row.account}`]),
      ]),
      h("span", { class: "ledger-amount" }, [formatCurrency(row.amountEur)]),
    ]),
  );

  const children: Array<Node | string> = [h("div", { class: "stats" }, [summary])];
  if (rows.length > 0) {
    children.push(
      h("details", { class: "allocation" }, [
        h("summary", { class: "alloc-summary" }, [
          h("span", { class: "alloc-summary-title" }, ["Recent contributions"]),
          h("span", { class: "muted" }, [`${recent.length} shown`]),
        ]),
        h("ul", { class: "ledger-list" }, rows),
      ]),
    );
  }
  return h("section", { class: "deposits" }, [sectionHead("Contributions"), ...children]);
}

function renderPeriodsPanel(periods: PeriodsView, deposits: DepositsView | null): HTMLElement {
  const children: Array<Node | string> = [
    renderPeriodList("This year, by month", periods.monthly, "periods-monthly"),
    renderPeriodList("By year", periods.yearly, "periods-yearly"),
  ];
  if (deposits) children.push(renderDepositsBlock(deposits));
  children.push(
    h("p", { class: "disclaimer" }, [
      "The current month and year are recomputed live; completed periods are frozen as of the last export.",
    ]),
  );
  return h("section", { class: "panel-stack panel-periods" }, children);
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

/** A small tappable "i" that reveals a definition (hover/focus and tap). */
function infoDot(text: string): HTMLElement {
  const tip = h("span", { class: "info-tip", role: "tooltip" }, [text]);
  const button = h(
    "button",
    { class: "info-dot", type: "button", "aria-label": `What is this? ${text}` },
    [h("span", { "aria-hidden": "true" }, ["i"]), tip],
  );
  // Tap toggles the tooltip on touch devices (where :hover never fires).
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    button.classList.toggle("open");
  });
  return button;
}

/** A metric stat card whose label carries an info dot when a definition exists. */
function metricStat(metric: RiskMetric): HTMLElement {
  const cls = metric.kind === "pct" ? signClass(metric.value) : "flat";
  const labelChildren: Array<Node | string> = [metric.label];
  const info = METRIC_INFO[metric.label];
  if (info) labelChildren.push(infoDot(info));
  return h("div", { class: "stat" }, [
    h("span", { class: "stat-label" }, labelChildren),
    h("span", { class: `stat-value ${cls}` }, [renderMetricValue(metric)]),
  ]);
}

function renderMetricValue(metric: RiskMetric): string {
  if (metric.value === null) return "—";
  if (metric.kind === "pct") return formatPercent(metric.value);
  if (metric.kind === "money") return formatCurrency(metric.value);
  return metric.value.toNumber().toFixed(2);
}

function renderMetricGrid(metrics: RiskMetric[]): HTMLElement {
  return h("div", { class: "stat-grid" }, metrics.map(metricStat));
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
    series.push({ values: points.map((p) => p.benchmarkValue), className: "series-benchmark" });
  }

  const chart = buildLineChart({ dates, series });
  if (!chart) return null;

  const legend: Array<Node | string> = [legendItem("series-portfolio", "Portfolio")];
  if (hasContribs) legend.push(legendItem("series-contrib", "Contributions"));
  if (hasBenchmark) legend.push(legendItem("series-benchmark", benchmarkSymbol ?? "Benchmark"));

  return h("section", { class: "card equity" }, [
    h("div", { class: "section-head" }, [
      h("h2", {}, ["Equity curve"]),
      h("span", { class: "muted" }, ["value over time"]),
    ]),
    h("div", { class: "chart-wrap" }, [chart as unknown as HTMLElement]),
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
  // last exported point, so the curve runs right up to "today".
  const lastDate = dates[dates.length - 1];
  if (o.asOf > lastDate) {
    dates.push(o.asOf);
    values.push(o.totalValueEur);
  } else if (o.asOf === lastDate) {
    values[values.length - 1] = o.totalValueEur;
  }
  if (values.filter((v) => v !== null).length < 2) return null;

  const chart = buildLineChart({
    dates,
    series: [{ values, className: "series-portfolio", area: true }],
  });
  if (!chart) return null;

  const cls = signClass(o.todayMoveEur);
  return h("section", { class: "card value-chart" }, [
    h("div", { class: "section-head" }, [
      h("h2", {}, ["Value over time"]),
      h("span", { class: `muted ${cls}` }, [
        o.todayMovePct !== null ? `${formatSignedPercent(o.todayMovePct)} today` : "today",
      ]),
    ]),
    h("div", { class: "chart-wrap" }, [chart as unknown as HTMLElement]),
    h("p", { class: "note" }, [`${dates[0]} → today · live tip from your current total value.`]),
  ]);
}

function renderAttribution(rows: AnalyticsView["attribution"]): HTMLElement | null {
  const top = rows.filter((r) => r.absolutePnlEur !== null).slice(0, 8);
  if (top.length === 0) return null;
  const items = top.map((r) =>
    h("li", { class: "ledger-row" }, [
      h("div", { class: "ledger-id" }, [
        h("span", { class: "ledger-kind" }, [r.symbol]),
        h("span", { class: "ledger-sub muted" }, [
          r.pctOfTotalReturn !== null ? `${formatPercent(r.pctOfTotalReturn)} of return` : "—",
        ]),
      ]),
      h("span", { class: `ledger-amount ${signClass(r.absolutePnlEur)}` }, [formatSignedCurrency(r.absolutePnlEur)]),
    ]),
  );
  return h("section", { class: "card" }, [
    h("div", { class: "section-head" }, [h("h2", {}, ["Attribution"]), h("span", { class: "muted" }, ["P/L by holding"])]),
    h("ul", { class: "ledger-list" }, items),
  ]);
}

function renderAnalyticsPanel(analytics: AnalyticsView | null): HTMLElement {
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

  const curve = renderEquityCurve(analytics.curve, analytics.benchmarkSymbol);
  if (curve) children.push(curve);
  const attribution = renderAttribution(analytics.attribution);
  if (attribution) children.push(attribution);

  children.push(
    h("p", { class: "disclaimer" }, [
      `History-bound risk metrics are computed on the desktop and shown as of the last export (${analytics.start} → ${analytics.asOf}). They do not move intraday.`,
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
 * The forward-projection calculator. Seeded from the live total value and the
 * average historical yearly contribution, it recomputes (in-browser, no
 * network) as the user adjusts the years and annual-contribution inputs.
 */
function renderPlanPanel(plan: PlanView): HTMLElement {
  const baseYear = plan.baseYear;
  const defaultContribution = plan.defaultAnnualContributionEur.toDecimalPlaces(0).toString();

  const years = numberField("Years", "10", { min: "1", max: "40", step: "1" });
  const contribution = numberField("Annual contribution (EUR)", defaultContribution, { min: "0", step: "100" });

  const output = h("div", { class: "plan-output" }, []);

  const recompute = (): void => {
    const yearsValue = Math.max(1, Math.min(40, Math.round(Number(years.input.value) || 0)));
    const contribValue = Math.max(0, Number(contribution.input.value) || 0);
    const rows = projectForward(
      plan.startingValueEur,
      new Decimal(contribValue),
      yearsValue,
      baseYear,
    );
    renderProjection(output, rows, plan.startingValueEur);
  };

  years.input.addEventListener("input", recompute);
  contribution.input.addEventListener("input", recompute);

  const form = h("section", { class: "card plan-form" }, [
    h("div", { class: "section-head" }, [h("h2", {}, ["Projection"]), h("span", { class: "muted" }, ["from today's value"])]),
    h("p", { class: "note" }, [
      `Starting from your live value of ${formatCurrency(plan.startingValueEur)}, growing at 4% / 7% / 10% a year with contributions added at year-end.`,
    ]),
    h("div", { class: "plan-fields" }, [years.wrap, contribution.wrap]),
  ]);

  recompute();
  return h("section", { class: "panel-stack panel-plan" }, [
    form,
    output,
    h("p", { class: "disclaimer" }, [
      "Projections are hypothetical, assume constant returns, and are not advice. Real markets vary year to year.",
    ]),
  ]);
}

function renderProjection(
  target: HTMLElement,
  rows: ReturnType<typeof projectForward>,
  startingValue: Decimal,
): void {
  if (rows.length === 0) {
    target.replaceChildren();
    return;
  }
  const last = rows[rows.length - 1];
  const cards = PROJECTION_SCENARIOS.map((rate) => {
    const value = last.valuesByRate.get(rate) ?? startingValue;
    const pct = `${new Decimal(rate).times(100).toNumber()}%/yr`;
    return h("div", { class: "stat" }, [
      h("span", { class: "stat-label" }, [pct]),
      h("span", { class: "stat-value pos" }, [formatCurrency(value)]),
      h("span", { class: "stat-sub muted" }, [`in ${last.year}`]),
    ]);
  });

  const tableRows = rows.map((row) => {
    const cells = PROJECTION_SCENARIOS.map((rate) =>
      h("span", { class: "proj-cell" }, [formatCurrency(row.valuesByRate.get(rate) ?? startingValue)]),
    );
    return h("li", { class: "proj-row" }, [
      h("span", { class: "proj-year" }, [String(row.year)]),
      h("span", { class: "proj-contrib muted" }, [`+${formatCurrency(row.contributedEur)}`]),
      h("div", { class: "proj-values" }, cells),
    ]);
  });

  target.replaceChildren(
    h("section", { class: "stats" }, [h("div", { class: "stat-grid plan-summary" }, cards)]),
    h("section", { class: "card" }, [
      h("div", { class: "proj-head" }, [
        h("span", { class: "proj-year muted" }, ["Year"]),
        h("span", { class: "proj-contrib muted" }, ["Contributed"]),
        h("div", { class: "proj-values" }, PROJECTION_SCENARIOS.map((rate) =>
          h("span", { class: "proj-cell muted" }, [`${new Decimal(rate).times(100).toNumber()}%`]),
        )),
      ]),
      h("ul", { class: "proj-list" }, tableRows),
    ]),
  );
}

/**
 * Self-contained colour-theme toggle. Cycles System → Light → Dark and updates
 * its own glyph/label in place, so both the live dashboard and demo share it
 * without threading state through the controller.
 */
function renderThemeToggle(): HTMLElement {
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
 * EUR ↔ USD display-currency toggle. The compute layer is EUR-only; flipping
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
