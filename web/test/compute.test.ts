/**
 * Unit tests for the live computation layer with injected quotes + FX, so they
 * run offline and deterministically.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { buildDashboard } from "../src/compute";
import type { FxRates, Quote } from "../src/prices";
import type { MobileExport } from "../src/types";

function makeExport(): MobileExport {
  return {
    meta: {
      schema_version: 1,
      app_version: "test",
      generated_at: "2024-06-01T00:00:00+00:00",
      as_of: "2024-06-01",
      display_currency: "EUR",
      fx_pivot: "EUR",
      fx_rate_eur_usd: "1.10",
      currency_note: "test",
    },
    holdings: [
      {
        symbol: "VTI",
        name: "Vanguard Total Market",
        asset_class: "etf",
        broker: "Broker",
        account: "Taxable",
        native_currency: "USD",
        shares: "10",
        cost_basis_native: "1000",
        cumulative_dividends_cash_native: "0",
        price_symbol: "VTI",
        price_type: "market",
        last_known_price_native: "90",
        cashflows: [{ date: "2023-01-01", amount: "-1000" }],
      },
      {
        symbol: "FXAIX",
        name: "Fidelity 500",
        asset_class: "mutual_fund",
        broker: "Broker",
        account: "Taxable",
        native_currency: "USD",
        shares: "5",
        cost_basis_native: "500",
        cumulative_dividends_cash_native: "0",
        price_symbol: "FXAIX",
        price_type: "nav",
        last_known_price_native: "100",
        cashflows: [{ date: "2023-06-01", amount: "-500" }],
      },
    ],
    portfolio_cashflows: [
      { date: "2023-01-01", amount: "-1000" },
      { date: "2023-06-01", amount: "-500" },
    ],
    cash: [{ account_label: "Direct", broker: "Bank", native_currency: "EUR", balance_native: "200" }],
    period_openings: {
      month_start_value_eur: "0",
      year_start_value_eur: "0",
      holdings: {},
    },
  };
}

const fx: FxRates = { base: "EUR", rates: { USD: new Decimal("1.10") } };

const quotes = new Map<string, Quote>([
  ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
  // FXAIX deliberately absent → falls back to last_known_price_native.
]);

function approx(actual: Decimal | null, expected: number, tol = 1e-4): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as Decimal).toNumber() - expected)).toBeLessThanOrEqual(tol);
}

describe("buildDashboard", () => {
  const model = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"));

  it("totals holdings + cash in EUR", () => {
    // VTI 1000 USD/1.10 = 909.0909, FXAIX 500 USD/1.10 = 454.5454, cash 200 EUR.
    approx(model.overview.totalValueEur, 909.0909 + 454.5454 + 200, 1e-3);
    approx(model.overview.cashValueEur, 200);
    expect(model.overview.holdingsCount).toBe(2);
  });

  it("computes today's move from the live previous close", () => {
    // (100 − 95) × 10 = 50 USD → 45.4545 EUR; FXAIX (NAV) contributes nothing.
    approx(model.overview.todayMoveEur, 45.4545, 1e-3);
    // pct = todayMoveEur / (totalValue − todayMoveEur) in EUR terms.
    approx(model.overview.todayMovePct, 45.4545 / (909.0909 + 454.5454 + 200 - 45.4545), 1e-4);
  });

  it("flags the fallback price source per holding", () => {
    const vti = model.holdings.find((h) => h.symbol === "VTI")!;
    const fxaix = model.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(vti.priceIsLive).toBe(true);
    expect(fxaix.priceIsLive).toBe(false);
    expect(fxaix.todayMoveEur).toBeNull();
    expect(model.overview.missingPriceSymbols).toEqual([]);
    expect(model.overview.fxMissingCurrencies).toEqual([]);
  });

  it("weights sum to ~1 across priced holdings + cash share", () => {
    const sum = model.holdings.reduce((acc, h) => acc + (h.weight?.toNumber() ?? 0), 0);
    // Holdings weight excludes the cash slice, so it is < 1 but > 0.
    expect(sum).toBeGreaterThan(0.5);
    expect(sum).toBeLessThan(1);
  });

  it("produces a portfolio XIRR (sign change present)", () => {
    expect(model.overview.portfolioXirr).not.toBeNull();
  });

  it("flags a missing FX leg", () => {
    const noFx: FxRates = { base: "EUR", rates: {} };
    const m = buildDashboard(makeExport(), quotes, noFx, new Date("2024-06-01T12:00:00Z"));
    expect(m.overview.fxMissingCurrencies).toContain("USD");
  });
});
