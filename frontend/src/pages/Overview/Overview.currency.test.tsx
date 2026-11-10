/**
 * A currency switch must not move the page (owner report, 6.4: on a phone the
 * cards below jumped). The `/both` hooks select one side of the same payload;
 * every section must render the same element structure on both sides.
 */
import { render as rtlRender } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const ccy = vi.hoisted(() => ({ value: "EUR" as "EUR" | "USD" }));

const kpis = (scale: number) => ({
  total_value: String(112606.59 * scale),
  total_invested: String(112157.17 * scale),
  capital_gain: String(449.42 * scale),
  total_return: String(449.42 * scale),
  xirr: "0.0039",
  ytd_xirr: "-0.02",
  total_growth_compounded: "0.0045",
  ytd_growth: "-0.017",
  mtd_growth: "-0.0016",
  daily_growth_pct: "-0.0031",
  daily_move: String(-347.59 * scale),
  daily_growth_as_of: "2026-11-04",
  weighted_expense_ratio: "0.0007",
  annual_expense_cost: String(78.8 * scale),
  dividend_income: "0",
  dividends_ttm: "0",
  dividend_yield_pct: "0",
  dividend_yield_ttm_pct: "0",
});

const side = (c: "EUR" | "USD") => {
  const other = c === "EUR" ? "USD" : "EUR";
  const scale = c === "EUR" ? 1 : 1.1887;
  return {
    ccy: c,
    secondary_ccy: other,
    as_of: "2026-11-04",
    generated_at: "2026-11-04T21:00:00Z",
    is_live: false,
    position_count: 2,
    fx_eur_usd: "1.1887",
    total_value_complete: true,
    default_range: "1m",
    warnings: { zero_value: [], bad_history: [], missing_fx: [] },
    kpis: kpis(scale),
    kpis_secondary: kpis(c === "EUR" ? 1.1887 : 1),
    market_verdict: { benchmark_symbol: "BMK", portfolio_return: "0.12", benchmark_return: "0.05", beating: true },
    daily_caption: { title: "Today", live: false, as_of_text: "today" },
    freshness: {
      market_state: "closed",
      prices_live: false,
      price_observed_at: "2026-11-04T21:00:41Z",
      refresh_running: false,
      historical: false,
      progress_done: 0,
      progress_total: 0,
    },
    currency: {
      lifetime: {
        avg_invest_rate: "1.0755",
        current_rate: "1.1887",
        rate_change_pct: "0.105",
        fx_pnl_eur: "-11852.93",
        repatriation_value_eur: "112606.59",
        breakeven_rate: "1.0755",
      },
      return_split: { investment_return: "0.123", currency_effect_pp: "-0.1188" },
      today: {
        pair: c === "EUR" ? "USD/EUR" : "EUR/USD",
        spot: "1.1887",
        spot_display: c === "EUR" ? "0.8413" : "1.1887",
        rate_move_pct: "0.0031",
        move: { pct: c === "EUR" ? "-0.0031" : "0.0031", anchor_kind: "prev_close", label_kind: "today", session_date: "2026-11-04" },
        since: { pct: "0.001", kind: "open" },
        as_of: { as_of: "2026-11-04", source: "eod", observed_at: null },
        since_phrase: { kind: "since_yesterday", session_date: "2026-11-04" },
        anchor_missing: false,
        regime: { market_open: false, forex_open: true, holiday: false, forex_frozen: false, single_overnight: false },
        effect_eur: { net: "-6176.74", market_hours: "374.81", overnight: "-6551.54" },
        investing_power_usd: { net: "6.18", market_hours: "-0.35", overnight: "6.54", amount_eur: "100", amount_usd: "118.87" },
      },
    },
    movers: {
      basis_date: "2026-11-04",
      eligible_count: 2,
      winners: [{ symbol: "AAA", name: "Alpha Fund", pct: "0.0072", move: String(174.92 * scale), reason: "total" }],
      losers: [{ symbol: "BBB", name: "Beta Corp", pct: "-0.0299", move: String(-295.83 * scale), reason: "total" }],
    },
  };
};

const holdingRow = (i: number, c: "EUR" | "USD") => {
  const scale = c === "EUR" ? 1 : 1.1887;
  return {
    instrument_id: i,
    symbol: i === 1 ? "AAA" : "BBB",
    name: i === 1 ? "Alpha Fund With A Long Name" : "Beta Corp",
    category: "Stocks",
    asset_class: "etf",
    account: "Main",
    native_currency: "USD",
    shares: "120",
    price_type: "market",
    is_money_market: false,
    market_open: false,
    daily_is_stale: false,
    value: String(24411.88 * scale * (i === 1 ? 1 : 0.4)),
    weight_pct: i === 1 ? "0.7" : "0.3",
    price_native: "241.82",
    price_as_of: "2026-11-04",
    avg_price_native: "218.04",
    today_pct: "0.0072",
    today_move: String(174.92 * scale),
    capital_gain: String(-82.41 * scale),
    total_return: String(-82.41 * scale),
    total_growth: "-0.0034",
    xirr: "-0.0034",
    updated_at: "2026-11-04T20:16:49",
    value_warning: false,
    price_data_warning: false,
  };
};

const both = { EUR: side("EUR"), USD: side("USD") };
const holdings = (c: "EUR" | "USD") => ({ ccy: c, as_of: "2026-11-04", holdings: [holdingRow(1, c), holdingRow(2, c)] });
// The hero's 1D mini chart (desktop right zone) reads the cached 1D graph.
const day = (c: "EUR" | "USD") => {
  const scale = c === "EUR" ? 1 : 1.1887;
  const v = (n: number) => String(n * scale);
  return {
    ccy: c,
    range: "1d",
    as_of: "2026-11-04",
    intraday: true,
    market_open: false,
    direction: c === "EUR" ? "down" : "up",
    reference: v(112954.18),
    session_date: "2026-11-04",
    sessions: [{ date: "2026-11-04", open: "2026-11-04T14:30:00Z", close: "2026-11-04T21:00:00Z" }],
    points: [
      { t: "2026-11-04T14:30:00Z", v: v(112800) },
      { t: "2026-11-04T17:00:00Z", v: v(113100) },
      { t: "2026-11-04T21:00:00Z", v: v(112606.59) },
    ],
  };
};
const idle = { data: undefined, isPending: true, isError: false, isFetching: false, refetch: vi.fn() };

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useOverview: (c: "EUR" | "USD") => ({ ...idle, data: both[c], isPending: false }),
  useHoldings: (c: "EUR" | "USD") => ({ ...idle, data: holdings(c), isPending: false }),
  useAllocations: () => idle,
  useGraph: (range: string, c: "EUR" | "USD") =>
    range === "1d" ? { ...idle, data: day(c), isPending: false } : idle,
}));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: ccy.value }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined, useShellSummary: () => undefined }));
vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));
vi.mock("./OnboardingCard", () => ({ OnboardingCard: () => null }));

import { ToastProvider } from "../../components/Toast";
import { Overview } from "./Overview";

/**
 * Every element as "tag.class class", in document order: the page's structure
 * without its text. Gain / loss modifiers are dropped (a move can flip sign
 * between currencies, and so can the 1D trend up / down; that recolours, it does
 * not move anything).
 *
 * `data-ccy-specific` marks a figure that genuinely exists in only one currency
 * — the overnight FX move is the case: a dollar book reported in dollars cannot
 * drift overnight, so the figure is not "missing" in USD, it does not exist.
 * Those elements and their subtrees are left out of the comparison. The rule this
 * test enforces is that a currency switch must not silently drop or reorder a
 * section; it is not that both views must say the same number of things.
 */
function structure(root: Element): string[] {
  return [...root.querySelectorAll("*")]
    .filter((el) => el.closest("[data-ccy-specific]") === null)
    .map((el) => `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").replace(/--(pos|neg|flat|up|down)/g, "")}`);
}

function renderIn(c: "EUR" | "USD") {
  ccy.value = c;
  return rtlRender(
    <MemoryRouter>
      <ToastProvider>
        <Overview />
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  ccy.value = "EUR";
  localStorage.clear();
});

describe("Overview currency switch", () => {
  it("renders the same sections and rows in EUR and USD", () => {
    const eur = renderIn("EUR");
    const eurShape = structure(eur.container);
    const eurCards = [...eur.container.querySelectorAll(".card__title, .overview-hero")].map((n) => n.textContent);
    expect(eur.container.querySelectorAll(".currency-box__amount")).toHaveLength(0);
    eur.unmount();
    const usd = renderIn("USD");
    const usdShape = structure(usd.container);
    const usdCards = [...usd.container.querySelectorAll(".card__title, .overview-hero")].length;
    expect(usdCards).toBe(eurCards.length);
    expect(usd.container.querySelectorAll(".overview-holdings__row")).toHaveLength(2);
    expect(usd.container.querySelectorAll(".movers-card__row")).toHaveLength(2);
    // The currency box keeps the same lines (the "Regular €100 · $118.87 today" line in both).
    expect(usd.container.querySelectorAll(".currency-box__amount")).toHaveLength(1);
    // The hero's day curve renders in both (its trend modifier may flip; the boxes do not move).
    expect(usd.container.querySelectorAll(".overview-hero__aside .hero-intraday__line")).toHaveLength(1);
    expect(usd.container.querySelectorAll(".hero-intraday__fact")).toHaveLength(3);
    const diff = usdShape.flatMap((s, i) => (s === eurShape[i] ? [] : [`${i}: ${eurShape[i]} -> ${s}`]));
    expect(diff).toEqual([]);
  });
});
