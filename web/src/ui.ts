/**
 * DOM rendering. Everything is built with `document.createElement` and
 * `textContent` (never `innerHTML` with interpolated data) so decrypted
 * financial figures can never be interpreted as markup — a small XSS guard on
 * data that, while local, is user-sensitive.
 */
import type { DashboardModel, HoldingView, OverviewView } from "./compute";
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

function card(title: string, body: Array<Node | string>): HTMLElement {
  return h("section", { class: "card" }, [h("h2", {}, [title]), ...body]);
}

function kpi(label: string, value: string, cls = "flat", sub?: string): HTMLElement {
  const children: Array<Node | string> = [
    h("span", { class: "kpi-label" }, [label]),
    h("span", { class: `kpi-value ${cls}` }, [value]),
  ];
  if (sub) children.push(h("span", { class: `kpi-sub ${cls}` }, [sub]));
  return h("div", { class: "kpi" }, children);
}

function renderOverview(o: OverviewView): HTMLElement {
  const grid = h("div", { class: "kpi-grid" }, [
    kpi("Total value", formatCurrency(o.totalValueEur)),
    kpi(
      "Today",
      formatSignedCurrency(o.todayMoveEur),
      signClass(o.todayMoveEur),
      formatSignedPercent(o.todayMovePct),
    ),
    kpi(
      "Total gain",
      formatSignedCurrency(o.totalGainEur),
      signClass(o.totalGainEur),
      formatSignedPercent(o.totalGainPct),
    ),
    kpi("Portfolio XIRR", formatPercent(o.portfolioXirr), signClass(o.portfolioXirr)),
    kpi("Invested", formatCurrency(o.totalCostBasisEur)),
    kpi("Cash & savings", formatCurrency(o.cashValueEur)),
  ]);

  const notes: Array<Node | string> = [];
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
  notes.push(
    h("p", { class: "note" }, [`Data exported ${formatTimestamp(o.generatedAt)}; live as of ${o.asOf}.`]),
  );

  return card("Overview", [grid, ...notes]);
}

function cell(text: string, cls = ""): HTMLElement {
  return h("td", cls ? { class: cls } : {}, [text]);
}

function renderHoldingRow(holding: HoldingView): HTMLElement {
  const nameChildren: Array<Node | string> = [h("span", { class: "sym" }, [holding.symbol])];
  if (holding.priceType === "nav") nameChildren.push(h("span", { class: "pill" }, ["NAV"]));
  if (holding.priceNative !== null && !holding.priceIsLive) {
    nameChildren.push(h("span", { class: "pill stale" }, ["last known"]));
  }
  nameChildren.push(h("span", { class: "name" }, [holding.name]));
  const nameCell = h("td", {}, nameChildren);

  return h("tr", {}, [
    nameCell,
    cell(formatShares(holding.shares), "num"),
    cell(formatNativePrice(holding.priceNative, holding.nativeCurrency), "num"),
    cell(formatSignedPercent(holding.todayMovePct), `num ${signClass(holding.todayMovePct)}`),
    cell(formatCurrency(holding.valueEur), "num"),
    cell(holding.weight !== null ? formatPercent(holding.weight) : "—", "num"),
    cell(formatSignedCurrency(holding.unrealisedPlEur), `num ${signClass(holding.unrealisedPlEur)}`),
    cell(formatPercent(holding.xirr), `num ${signClass(holding.xirr)}`),
  ]);
}

function renderHoldings(holdings: HoldingView[]): HTMLElement {
  const head = h("thead", {}, [
    h("tr", {}, [
      h("th", {}, ["Holding"]),
      h("th", { class: "num" }, ["Shares"]),
      h("th", { class: "num" }, ["Price"]),
      h("th", { class: "num" }, ["Today"]),
      h("th", { class: "num" }, ["Value"]),
      h("th", { class: "num" }, ["Weight"]),
      h("th", { class: "num" }, ["Unrealised P/L"]),
      h("th", { class: "num" }, ["XIRR"]),
    ]),
  ]);
  const sorted = [...holdings].sort((a, b) => {
    const av = a.valueEur?.toNumber() ?? -1;
    const bv = b.valueEur?.toNumber() ?? -1;
    return bv - av;
  });
  const body = h("tbody", {}, sorted.map(renderHoldingRow));
  return card("Holdings", [h("div", { class: "table-wrap" }, [h("table", {}, [head, body])])]);
}

export function renderDashboard(model: DashboardModel, onRefresh: () => void, onLock: () => void): HTMLElement {
  const actions = h("div", { class: "toolbar" }, [
    h("button", { class: "btn", type: "button", "data-action": "refresh" }, ["Refresh prices"]),
    h("button", { class: "btn ghost", type: "button", "data-action": "lock" }, ["Lock"]),
  ]);
  actions.querySelector('[data-action="refresh"]')?.addEventListener("click", onRefresh);
  actions.querySelector('[data-action="lock"]')?.addEventListener("click", onLock);

  return h("main", { class: "dashboard" }, [
    h("header", { class: "app-header" }, [h("h1", {}, ["Live Web Companion"]), actions]),
    renderOverview(model.overview),
    renderHoldings(model.holdings),
    h("p", { class: "disclaimer" }, [
      "Read-only. Live figures are computed in your browser from public market data and may differ slightly from your broker.",
    ]),
  ]);
}
