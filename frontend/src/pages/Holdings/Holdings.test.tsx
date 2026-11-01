import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HoldingsDto } from "../../lib/queries/portfolio";

const holdings: HoldingsDto = {
  as_of: "2026-10-30",
  ccy: "EUR",
  total_value: "1000",
  total_capital_gain: "100",
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
      value_warning: true,
      price_data_warning: false,
    },
  ],
  summary: { in_profit: 1, in_loss: 0, gainers: 1, losers: 0 },
};

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useHoldings: () => ({ data: holdings, isPending: false, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

import { Holdings, groupHoldings } from "./Holdings";

describe("Holdings page", () => {
  it("renders the table with row flags and a search box", () => {
    render(<Holdings />);
    expect(screen.getAllByText("VWCE").length).toBeGreaterThan(0);
    expect(screen.getByText("stale value")).toBeInTheDocument();
    expect(screen.getByLabelText("Search holdings")).toHaveAttribute("data-search");
  });

  it("sums subtotals per group, largest first", () => {
    const base = holdings.holdings[0];
    const rows = [
      { ...base, instrument_id: 1, account: "A", value: "100", capital_gain: "10" },
      { ...base, instrument_id: 2, account: "B", value: "500", capital_gain: "-5" },
      { ...base, instrument_id: 3, account: "A", value: "50", capital_gain: "5" },
    ];
    const groups = groupHoldings(rows, "account");
    expect(groups.map((g) => g.key)).toEqual(["B", "A"]);
    expect(groups[1].value).toBe(150);
    expect(groups[1].gain).toBe(15);
    expect(groupHoldings(rows, "none")).toHaveLength(1);
  });

  it("shows group subtotals when grouped", () => {
    render(<Holdings />);
    expect(screen.queryByLabelText(/^Subtotal/)).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Group by" }));
    fireEvent.click(screen.getByRole("option", { name: "By account" }));
    expect(screen.getByLabelText("Subtotal A")).toBeInTheDocument();
  });

  it("opens the detail drawer with a cost-basis line", () => {
    render(<Holdings />);
    fireEvent.click(screen.getByRole("button", { name: "Details for VWCE" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("VWCE price against cost basis")).toBeInTheDocument();
    expect(screen.getByText("Cost basis", { selector: "text" })).toBeInTheDocument();
  });
});
