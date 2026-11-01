import { render, screen } from "@testing-library/react";
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
      value_warning: true,
      price_data_warning: false,
    },
  ],
  summary: { gainers: 1, losers: 0 },
};

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useHoldings: () => ({ data: holdings, isPending: false, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

import { Holdings } from "./Holdings";

describe("Holdings page", () => {
  it("renders the table with row flags and a search box", () => {
    render(<Holdings />);
    expect(screen.getAllByText("VWCE").length).toBeGreaterThan(0);
    expect(screen.getByText("stale value")).toBeInTheDocument();
    expect(screen.getByLabelText("Search holdings")).toHaveAttribute("data-search");
  });
});
