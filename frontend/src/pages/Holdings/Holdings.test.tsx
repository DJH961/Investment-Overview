import { fireEvent, render, screen, within } from "@testing-library/react";
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

let groupOver: Record<string, unknown> = {};

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
      total_growth: "0.275",
      today_move: "10",
      today_pct: "0.01",
      est_value: null,
      est_today_move: null,
      ...groupOver,
    },
  ],
});

const twinRow = (over: Record<string, unknown> = {}) => ({
  ...holdings.holdings[0],
  instrument_id: 7,
  symbol: "FXAIX",
  name: "Index Fund",
  price_type: "nav",
  asset_class: "mutual_fund",
  value_warning: false,
  cost_basis: "800",
  dividends: "20",
  total_return: "220",
  mtd_growth: "0.02",
  ytd_growth: "0.12",
  expense_ratio: "0.0015",
  weight_pct: "0.5",
  twin: {
    symbol: "VOO",
    tier: "same_index",
    est_price: "101.5",
    est_value: "1015",
    est_today_move: "15",
    est_today_pct: "0.0042",
    at: "2026-10-30T20:00:00Z",
    pending: true,
    divergence: {
      last_pp: "0.034",
      last_money: "-3.4",
      last_date: "2026-10-29",
      median_abs_pp: "0.052",
      bias_pp: "0.021",
      sessions: 17,
      window: 20,
    },
  },
  ...over,
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

import { HideAmountsProvider } from "../../lib/hideAmounts";
import { Holdings } from "./Holdings";

beforeEach(() => {
  phone.value = false;
  groupOver = {};
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
    const sub = screen.getByLabelText("Subtotal A");
    // One row in table order: value, weight, day, P/L, total return; cost basis / dividends sit behind an (i).
    for (const key of ["Value", "Weight", "Day", "P/L", "Total return"]) expect(within(sub).getByText(key)).toBeInTheDocument();
    expect(within(sub).queryByText("Cost basis")).toBeNull();
    expect(within(sub).queryByText("Dividends")).toBeNull();
    expect(within(sub).getByRole("button", { name: "About cost basis, dividends and the return percentage" })).toBeInTheDocument();
    expect(within(sub).getByText("+€10.00")).toBeInTheDocument();
    expect(within(sub).getByText("+€220.00")).toBeInTheDocument();
    expect(within(sub).getByText("+27.50%")).toBeInTheDocument(); // simple return on cost
    expect(within(sub).queryByText("≈ est.")).toBeNull();
    expect(localStorage.getItem("iv.holdings.group")).toBe('"account"');
  });

  it("shows the summary as one strip, income, fee and FX included", () => {
    const { container } = render(<Holdings />);
    expect(container.querySelectorAll(".holdings-page__stats .holdings-page__stat")).toHaveLength(14);
    expect(screen.getByText("Dividend return")).toBeInTheDocument();
    expect(screen.getByText("Yield (TTM)")).toBeInTheDocument();
    expect(screen.getByText("Weighted fee")).toBeInTheDocument();
    expect(screen.getByText("FX USD/EUR")).toBeInTheDocument();
    expect(screen.getByText(/EOD · /)).toBeInTheDocument();
  });

  it("keeps the same summary stats when the FX block is absent (USD view)", () => {
    const fx = holdings.fx;
    holdings.fx = null;
    holdings.fx_eur_usd = "1.0830";
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelectorAll(".holdings-page__stats .holdings-page__stat")).toHaveLength(14);
      expect(screen.getByText("FX EUR/USD")).toBeInTheDocument();
    } finally {
      holdings.fx = fx;
    }
  });

  it("tints profitable rows and lists flagged symbols in one notice", () => {
    const { container } = render(<Holdings />);
    expect(container.querySelector(".holdings-page__row--gain")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Stale or zero value: VWCE");
  });

  it("says the price time once in the header and only on rows that differ", () => {
    const fund = {
      ...holdings.holdings[0],
      instrument_id: 2,
      symbol: "FXAIX",
      name: "Index Fund",
      asset_class: "mutual_fund",
      price_as_of: "2026-10-29",
      value_warning: false,
    };
    const etf2 = { ...holdings.holdings[0], instrument_id: 3, symbol: "VUSA", value_warning: false };
    const saved = holdings.holdings;
    holdings.holdings = [saved[0], etf2, fund];
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelector(".holdings-page__stamps .price-stamps")).toHaveTextContent(/Price as of .*\(close\)/);
      const stamps = [...container.querySelectorAll(".holdings-page__row-stamp")];
      // Only the fund (a NAV, from another day) carries its own stamp; never called a close.
      expect(stamps).toHaveLength(1);
      expect(stamps[0]).toHaveTextContent(/\(NAV\)/);
      expect(stamps[0]).not.toHaveTextContent(/close/);
      // The market is shut: the ETFs on the latest close get the tick, the fund behind them does not.
      expect(container.querySelectorAll(".price-tick")).toHaveLength(2);
      expect(container.querySelector(".price-tick")).toHaveAttribute("data-tick", "Up to date with the latest close");
    } finally {
      holdings.holdings = saved;
    }
  });

  it("on a phone shows today in money and the price chart button", () => {
    phone.value = true;
    const { container } = render(<Holdings />);
    // One holding: its price time is the list's, said once in the header, not on the row.
    expect(container.querySelector(".holdings-page__row-stamp")).toBeNull();
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
      expect(container.querySelector(".holdings-page__today--stale")).toHaveTextContent(/an earlier session's move/);
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

  it("shows money only when the group return on cost is null", () => {
    groupOver = { total_growth: null };
    render(<Holdings />);
    fireEvent.click(screen.getByRole("combobox", { name: "Group by" }));
    fireEvent.click(screen.getByRole("option", { name: "By account" }));
    const sub = screen.getByLabelText("Subtotal A");
    expect(within(sub).getByText("+€220.00")).toBeInTheDocument();
    expect(within(sub).queryByText(/27\.50/)).toBeNull();
  });

  it("shows an estimate chip in the group value and day cells when funds are pending", () => {
    groupOver = { est_value: "1015", est_today_move: "25" };
    render(<Holdings />);
    fireEvent.click(screen.getByRole("combobox", { name: "Group by" }));
    fireEvent.click(screen.getByRole("option", { name: "By account" }));
    const sub = screen.getByLabelText("Subtotal A");
    expect(within(screen.getByTestId("group-est-value")).getByText("≈ est.")).toBeInTheDocument();
    expect(within(screen.getByTestId("group-est-value")).getByText("€1,015.00")).toBeInTheDocument();
    expect(within(screen.getByTestId("group-est-move")).getByText("+€25.00")).toBeInTheDocument();
    expect(within(sub).getByRole("button", { name: "About the estimated value" })).toBeInTheDocument();
  });

  it("lists a pending twin quietly in the symbol cell, and drops the line once the NAV posted", () => {
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      const { container, unmount } = render(<Holdings />);
      const line = container.querySelector(".holdings-page__twin-line");
      expect(line).toHaveTextContent(/≈\s*VOO\s*\+0\.42%/);
      unmount();
      holdings.holdings = [twinRow({ twin: { ...twinRow().twin, pending: false, est_price: null, est_value: null, est_today_move: null, est_today_pct: null, at: null } })] as typeof saved;
      const again = render(<Holdings />);
      expect(again.container.querySelector(".holdings-page__twin-line")).toBeNull();
    } finally {
      holdings.holdings = saved;
    }
  });

  it("shows the Twin block with estimate and divergence in the desktop drawer", () => {
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      render(<Holdings />);
      fireEvent.click(screen.getByRole("button", { name: "Details for FXAIX" }));
      const block = screen.getByLabelText("ETF twin of FXAIX");
      expect(within(block).getByText(/Same index/)).toBeInTheDocument();
      expect(within(block).getByText("Estimated value")).toBeInTheDocument();
      expect(within(block).getByText("€1,015.00")).toBeInTheDocument();
      expect(within(block).getByText("+0.03 pp")).toBeInTheDocument(); // last session
      expect(within(block).getByText("-€3.40")).toBeInTheDocument();
      expect(within(block).getByText(/over 17 of 20 sessions/)).toBeInTheDocument();
      expect(within(block).getByText(/twin runs high/)).toBeInTheDocument();
      expect(within(block).getByRole("button", { name: "About twin divergence" })).toBeInTheDocument();
    } finally {
      holdings.holdings = saved;
    }
  });

  it("says so when there is not enough history for a divergence, and hides the estimate once posted", () => {
    const saved = holdings.holdings;
    holdings.holdings = [twinRow({ twin: { ...twinRow().twin, pending: false, divergence: null } })] as typeof saved;
    try {
      render(<Holdings />);
      fireEvent.click(screen.getByRole("button", { name: "Details for FXAIX" }));
      const block = screen.getByLabelText("ETF twin of FXAIX");
      expect(within(block).getByText(/Not enough history yet/)).toBeInTheDocument();
      expect(within(block).queryByText("Estimated value")).toBeNull();
    } finally {
      holdings.holdings = saved;
    }
  });

  it("phone expansion shows only what the chips do not, plus the twin block", () => {
    phone.value = true;
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelector(".holdings-page__twin-line")).toHaveTextContent(/VOO/);
      fireEvent.click(screen.getByRole("button", { name: /FXAIX/ }));
      const detail = container.querySelector(".holdings-page__detail") as HTMLElement;
      const keys = [...detail.querySelectorAll("dt")].map((d) => d.textContent);
      for (const dup of ["Price", "Shares", "Unrealised gain", "Growth", "XIRR", "Weight"]) expect(keys).not.toContain(dup);
      for (const key of ["Avg price", "Cost basis", "Dividends", "MTD", "YTD", "Expense", "Account"]) expect(keys).toContain(key);
      expect(keys.some((k) => k?.startsWith("Total return"))).toBe(true);
      expect(screen.getByLabelText("ETF twin of FXAIX")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Price chart" })).toBeInTheDocument();
    } finally {
      holdings.holdings = saved;
    }
  });

  it("hide mode masks twin money but keeps the percentages", () => {
    localStorage.setItem("iv.privacy.hideAmounts", "true");
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      const { container } = render(
        <HideAmountsProvider>
          <Holdings />
        </HideAmountsProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Details for FXAIX" }));
      const text = container.ownerDocument.body.textContent ?? "";
      expect(text).not.toMatch(/1,015|3\.40/);
      expect(text).toContain("+0.42%");
      expect(text).toContain("+0.03 pp");
    } finally {
      holdings.holdings = saved;
    }
  });

  it("hide mode leaves no amount or share count in the DOM", () => {
    localStorage.setItem("iv.privacy.hideAmounts", "true");
    const { container } = render(
      <HideAmountsProvider>
        <Holdings />
      </HideAmountsProvider>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("••,•••");
    expect(text).toContain("VWCE");
    expect(text).not.toMatch(/1,000|1000|200\.00|120\.00|220\.00|10\.0000|€\s?10\.00/);
  });
});
