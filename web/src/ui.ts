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
  type DepositsView,
  type PeriodRowView,
  type PeriodsView,
  type PlanView,
  type RiskMetric,
  projectForward,
  PROJECTION_SCENARIOS,
} from "./phase4";
import {
  formatAsOf,
  formatLastPull,
  formatCurrency,
  formatCurrencyWhole,
  formatDualCurrency,
  formatFxRate,
  formatNativePrice,
  formatPercent,
  formatShares,
  formatSignedCurrency,
  formatSignedDualCurrency,
  formatSignedPercent,
  formatTimestamp,
  signClass,
} from "./format";
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

  // Per-holding rows and the footer note both carry "as of" freshness, so the
  // hero stays clean: just the headline value and today's move, with no date
  // stamped above "Total value" at the very top of the screen.
  const children: Array<Node | string> = [
    h("span", { class: "hero-label" }, ["Total value"]),
    h("span", { class: "hero-value" }, [formatCurrency(o.totalValueEur)]),
    change,
  ];
  const fxLine = renderHeroFx(o);
  if (fxLine) children.push(fxLine);
  return h("section", { class: "hero" }, children);
}

/**
 * The live EUR/USD context under today's move: the current spot, how much of
 * today's move came from the EUR/USD swing (the FX-aware part), and an honest
 * "end-of-day FX" tag when only the ECB daily rate was available. Returns null
 * when there's nothing useful to show (no rate and no FX contribution).
 */
function renderHeroFx(o: OverviewView): HTMLElement | null {
  const parts: HTMLElement[] = [];
  const inUsd = getDisplayCurrency() === "USD";
  if (o.fxRateEurUsd !== null) {
    // The spot rate, plus how far it has moved today (the % the FX has
    // deviated) — the cause behind the FX P/L slice below.
    const devPct = fxTodayDeviationPct(o);
    const rateLabel =
      devPct !== null
        ? `EUR/USD ${formatFxRate(o.fxRateEurUsd)} (${formatSignedPercent(devPct)} today)`
        : `EUR/USD ${formatFxRate(o.fxRateEurUsd)}`;
    parts.push(h("span", { class: "hero-fx-rate" }, [rateLabel]));
  }
  // The FX-revaluation slice of today's move. It is intrinsically a *EUR-side*
  // effect: a USD-booked holding only changes in EUR when EUR/USD moves; its USD
  // value is unaffected. So in USD display there is — correctly — no FX P/L to
  // book (you can't "make money on FX" when everything is already in USD); we
  // simply omit the line rather than printing a reminder that reflows the page.
  // In EUR display we show the actual EUR the swing added or removed today.
  if (!o.todayFxMoveEur.isZero() && !inUsd) {
    const fxCls = signClass(o.todayFxMoveEur);
    parts.push(
      h("span", { class: `hero-fx-split ${fxCls}` }, [
        `incl. ${formatSignedCurrency(o.todayFxMoveEur)} from FX`,
      ]),
    );
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
    segment("Today", o.todayMovePct),
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

function renderNotes(o: OverviewView): HTMLElement[] {
  const notes: HTMLElement[] = [];
  // Lead with the live-coverage line: a calm, descriptive "how much is fresh"
  // status that replaces both the opaque "some prices not updated" and the old
  // floating banner — it stays on the page, but doesn't hover or nag.
  if (o.liveCoverage) {
    notes.push(h("p", { class: "note coverage" }, [o.liveCoverage]));
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
        `FX EUR→USD ${o.fxRateEurUsd.toFixed(4)} · dividends ${formatCurrency(o.totalDividendsEur)} to date.`,
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

  const todayCls = signClass(holding.todayMovePct);
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
      h("span", { class: `holding-change ${todayCls}` }, [signedPercentOrDash(holding.todayMovePct)]),
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

function renderPeriodList(title: string, rows: PeriodRowView[], extraClass = ""): HTMLElement {
  const cls = `holdings ${extraClass}`.trim();
  if (rows.length === 0) {
    return h("section", { class: cls }, [sectionHead(title), h("p", { class: "note" }, ["No periods yet."])]);
  }
  const list = h("ul", { class: "holding-list" }, rows.map(renderPeriodRow));
  const sub = `${rows.length} ${rows.length === 1 ? "period" : "periods"}`;
  return collapsibleSection(title, sub, list, cls);
}

function renderDepositsBlock(deposits: DepositsView): HTMLElement {
  const summary = h("div", { class: "stat-grid" }, [
    stat("Contributed", formatDualCurrency(deposits.totalEur, deposits.totalUsd)),
    stat("This year", formatDualCurrency(deposits.ytdEur, deposits.ytdUsd)),
    stat("This month", formatDualCurrency(deposits.mtdEur, deposits.mtdUsd)),
  ]);

  const recent = deposits.rows.slice(0, 12);
  const rows = recent.map((row) =>
    h("li", { class: "ledger-row" }, [
      h("div", { class: "ledger-id" }, [
        h("span", { class: "ledger-kind" }, [titleCase(row.kind)]),
        h("span", { class: "ledger-sub muted" }, [`${row.date} · ${row.account}`]),
      ]),
      h("span", { class: "ledger-amount" }, [formatDualCurrency(row.amountEur, row.amountUsd)]),
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
function chartWithTimeframe(dates: string[], series: ChartSeries[]): HTMLElement | null {
  const full = buildLineChart({ dates, series });
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
    const chart = buildLineChart({ dates: slicedDates, series: slicedSeries });
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

  const cls = signClass(o.todayMoveEur);
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
        o.todayMovePct !== null ? `${formatSignedPercent(o.todayMovePct)} today` : "today",
      ]),
    ]),
    chart,
  ];
  if (note) children.push(h("p", { class: "note" }, [note]));
  return h("section", { class: "card value-chart" }, children);
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
  return collapsibleSection("Attribution", "P/L by holding", h("ul", { class: "ledger-list" }, items), "card attribution");
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
  // The projection runs in EUR, but the user sees and types in the active
  // display currency — so seed the default and the field label in that currency
  // and convert what they enter back to EUR before projecting.
  const defaultContribution = convertFromEur(plan.defaultAnnualContributionEur);
  const displayCode = defaultContribution.code;
  const defaultContributionDisplay = defaultContribution.value.toDecimalPlaces(0).toString();

  const years = numberField("Years", "10", { min: "1", max: "40", step: "1" });
  const contribution = numberField(`Annual contribution (${displayCode})`, defaultContributionDisplay, {
    min: "0",
    step: "100",
  });

  const summaryOut = h("div", { class: "plan-summary-wrap" }, []);
  const tableOut = h("div", { class: "plan-table-wrap" }, []);

  const recompute = (): void => {
    const yearsValue = Math.max(1, Math.min(40, Math.round(Number(years.input.value) || 0)));
    const contribDisplay = Math.max(0, Number(contribution.input.value) || 0);
    const contribInput = new Decimal(contribDisplay);
    const contribEur = displayCode === "EUR" ? contribInput : convertToEur(contribInput);
    const rows = projectForward(plan.startingValueEur, contribEur, yearsValue, baseYear);
    renderProjection(summaryOut, tableOut, rows, plan.startingValueEur);
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
    summaryOut,
    tableOut,
    h("p", { class: "disclaimer" }, [
      "Projections are hypothetical, assume constant returns, and are not advice. Real markets vary year to year.",
    ]),
  ]);
}

function renderProjection(
  summaryTarget: HTMLElement,
  tableTarget: HTMLElement,
  rows: ReturnType<typeof projectForward>,
  startingValue: Decimal,
): void {
  if (rows.length === 0) {
    summaryTarget.replaceChildren();
    tableTarget.replaceChildren();
    return;
  }
  const last = rows[rows.length - 1];
  const cards = PROJECTION_SCENARIOS.map((rate) => {
    const value = last.valuesByRate.get(rate) ?? startingValue;
    const pct = `${new Decimal(rate).times(100).toNumber()}%/yr`;
    return h("div", { class: "stat" }, [
      h("span", { class: "stat-label" }, [pct]),
      h("span", { class: "stat-value pos" }, [formatCurrencyWhole(value)]),
      h("span", { class: "stat-sub muted" }, [`in ${last.year}`]),
    ]);
  });

  const tableRows = rows.map((row) => {
    const cells = PROJECTION_SCENARIOS.map((rate) =>
      h("span", { class: "proj-cell" }, [formatCurrencyWhole(row.valuesByRate.get(rate) ?? startingValue)]),
    );
    return h("li", { class: "proj-row" }, [
      h("span", { class: "proj-year" }, [String(row.year)]),
      h("span", { class: "proj-contrib muted" }, [`+${formatCurrencyWhole(row.contributedEur)}`]),
      h("div", { class: "proj-values" }, cells),
    ]);
  });

  summaryTarget.replaceChildren(
    h("section", { class: "stats" }, [h("div", { class: "stat-grid plan-summary" }, cards)]),
  );
  tableTarget.replaceChildren(
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
