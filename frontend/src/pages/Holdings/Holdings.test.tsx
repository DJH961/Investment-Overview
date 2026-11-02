import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HoldingsDto } from "../../lib/queries/holdings";

const phone = vi.hoisted(() => ({ value: false }));

const holdings: HoldingsDto = {
  as_of: "2026-10-30",
  ccy: "EUR",
  total_value: "1000",
  total_capital_gain: "100",
  total_return: "120",
  total_growth: "0.25",
  xirr: "0.1",
  dividend_income: "20",
  dividends_ttm: "5",
  dividend_yield_pct: "0.02",
  dividend_yield_ttm_pct: "0.005",
  weighted_expense_ratio: "0.002",
  annual_expense_cost: "2",
  fx: { pair: "USD/EUR", spot: "0.9234", move_pct: "-0.001", as_of: "2026-10-30", source: "eod" },
  group_by: "none",
  groups: [],
  holdings: [
    {
      instrument_id: 1,
      symbol: "VWCE",
      name: "World ETF",
      category: "Equity",
      asset_class: "equity",
      account: "A",
      native_currency: "EUR",
      shares: "10",
      price_type: "market",
      is_money_market: false,
      market_open: false,
      daily_is_stale: false,
      value: "1000",
      price_native: "100",
      price_as_of: "2026-10-30",
      avg_price_native: "80",
      today_pct: "0.01",
      today_move: "10",
      capital_gain: "200",
      total_growth: "0.25",
      xirr: "0.1",
      updated_at: "2026-10-30T15:05:00Z",
      value_warning: true,
      price_data_warning: false,
    },
  ],
  summary: { in_profit: 1, in_loss: 0, gainers: 1, losers: 0 },
};

const accountGroups = (): HoldingsDto => ({
  ...holdings,
  group_by: "account",
  groups: [
    {
      key: "A",
      count: 1,
      instrument_ids: [1],
      value: "1000",
      cost_basis: "800",
      capital_gain: "200",
      dividends: "20",
      total_return: "220",
      weight_pct: "1",
    },
  ],
});

vi.mock("../../lib/useMediaQuery", async (orig) => ({
  ...(await orig<typeof import("../../lib/useMediaQuery")>()),
  useMediaQuery: () => phone.value,
}));

vi.mock("../../lib/queries/holdings", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/holdings")>()),
  useHoldingHistory: () => ({
    data: {
      instrument_id: 1,
      symbol: "VWCE",
      range: "1y",
      ccy: "EUR",
      points: [
        { t: "2026-10-28", v: "90" },
        { t: "2026-10-29", v: "95" },
        { t: "2026-10-30", v: "100" },
      ],
    },
    isPending: false,
    isError: false,
  }),
  useHoldings: (_ccy: string, by: string) => ({
    data: by === "account" ? accountGroups() : holdings,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

import { Holdings } from "./Holdings";

beforeEach(() => {
  phone.value = false;
  localStorage.clear();
});

describe("Holdings page", () => {
  it("renders the table with row flags and a search box", () => {
    render(<Holdings />);
    expect(screen.getAllByText("VWCE").length).toBeGreaterThan(0);
    expect(screen.getByText("stale value")).toBeInTheDocument();
    expect(screen.getByLabelText("Search holdings")).toHaveAttribute("data-search");
  });

  it("shows group subtotals when grouped", () => {
    render(<Holdings />);
    expect(screen.queryByLabelText(/^Subtotal/)).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Group by" }));
    fireEvent.click(screen.getByRole("option", { name: "By account" }));
    expect(screen.getByLabelText("Subtotal A")).toBeInTheDocument();
    expect(localStorage.getItem("iv.holdings.group")).toBe('"account"');
  });

  it("shows the income, expense and FX tiles of the second KPI row", () => {
    render(<Holdings />);
    expect(screen.getByText("Dividend return")).toBeInTheDocument();
    expect(screen.getByText("Dividend yield (TTM)")).toBeInTheDocument();
    expect(screen.getByText("Weighted expense")).toBeInTheDocument();
    expect(screen.getByText("Current FX (USD/EUR)")).toBeInTheDocument();
    expect(screen.getByText(/EOD · /)).toBeInTheDocument();
  });

  it("tints profitable rows and lists flagged symbols in one notice", () => {
    const { container } = render(<Holdings />);
    expect(container.querySelector(".holdings-page__row--gain")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Stale or zero value: VWCE");
  });

  it("on a phone shows the as-of stamp, today in money and the price chart button", () => {
    phone.value = true;
    const { container } = render(<Holdings />);
    expect(screen.getByText(/as of /)).toBeInTheDocument();
    expect(container.querySelector(".holdings-page__today")).toHaveTextContent("+€10.00"); // money move
    expect(container.querySelector(".holdings-page__today--stale")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /VWCE/ }));
    fireEvent.click(screen.getByRole("button", { name: "Price chart" }));
    expect(screen.getByLabelText("VWCE price against cost basis")).toBeInTheDocument();
  });

  it("greys the today move when the daily move is stale", () => {
    phone.value = true;
    holdings.holdings[0].daily_is_stale = true;
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelector(".holdings-page__today--stale")).not.toBeNull();
    } finally {
      holdings.holdings[0].daily_is_stale = false;
    }
  });

  it("opens the detail drawer with a cost-basis line", () => {
    render(<Holdings />);
    fireEvent.click(screen.getByRole("button", { name: "Details for VWCE" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("VWCE price against cost basis")).toBeInTheDocument();
    expect(screen.getByText("Cost basis", { selector: "text" })).toBeInTheDocument();
  });
});
