import { afterEach, describe, expect, it } from "vitest";
import type { ExportHolding } from "../src/types";
import { isMoneyMarketHolding, MONEY_MARKET_SYMBOLS } from "../src/money-market";

function holding(overrides: Partial<ExportHolding>): ExportHolding {
  return {
    symbol: "VTI",
    name: "Vanguard Total Stock Market ETF",
    asset_class: "etf",
    broker: "fidelity",
    account: "Brokerage",
    native_currency: "USD",
    shares: "1",
    cost_basis_native: "1",
    cumulative_dividends_cash_native: "0",
    price_symbol: "VTI",
    price_type: "market",
    last_known_price_native: "1",
    cashflows: [],
    ...overrides,
  };
}

describe("isMoneyMarketHolding", () => {
  it("matches well-known settlement tickers regardless of asset class", () => {
    expect(
      isMoneyMarketHolding(holding({ symbol: "VMFXX", price_symbol: "VMFXX", asset_class: "mutual_fund" })),
    ).toBe(true);
    expect(MONEY_MARKET_SYMBOLS.has("SPAXX")).toBe(true);
  });

  it("honours the explicit export flag", () => {
    expect(isMoneyMarketHolding(holding({ symbol: "CASHX", is_money_market: true }))).toBe(true);
  });

  it("matches a name mentioning money market", () => {
    expect(
      isMoneyMarketHolding(holding({ symbol: "ABCXX", price_symbol: "ABCXX", name: "Some Money Market Fund" })),
    ).toBe(true);
  });

  it("leaves ordinary holdings alone", () => {
    expect(isMoneyMarketHolding(holding({ symbol: "VTI" }))).toBe(false);
    expect(isMoneyMarketHolding(holding({ symbol: "FXAIX", asset_class: "mutual_fund", price_type: "nav" }))).toBe(false);
  });
});

afterEach(() => {
  /* nothing to clean up; pure functions */
});
