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
    // Every holding could be valued, so the live total is complete.
    expect(model.overview.totalValueIsComplete).toBe(true);
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
    // The USD holdings drop out of the EUR total, so it is incomplete.
    expect(m.overview.totalValueIsComplete).toBe(false);
  });

  it("marks the total incomplete when a holding has no usable price", () => {
    const exp = makeExport();
    // FXAIX has no live quote (absent from `quotes`) and no last-known price,
    // so it cannot be valued and falls out of the total.
    exp.holdings[1].last_known_price_native = null;
    const m = buildDashboard(exp, quotes, fx, new Date("2024-06-01T12:00:00Z"));
    expect(m.overview.missingPriceSymbols).toEqual(["FXAIX"]);
    expect(m.overview.totalValueIsComplete).toBe(false);
  });
});

function makePeriodExport(): MobileExport {
  return {
    meta: {
      schema_version: 1,
      app_version: "test",
      generated_at: "2024-06-15T00:00:00+00:00",
      as_of: "2024-06-15",
      display_currency: "EUR",
      fx_pivot: "EUR",
      fx_rate_eur_usd: "1.10",
      currency_note: "test",
    },
    holdings: [
      {
        symbol: "VWCE",
        name: "All-World",
        asset_class: "etf",
        broker: "Broker",
        account: "Taxable",
        native_currency: "EUR",
        shares: "100",
        cost_basis_native: "8000",
        cumulative_dividends_cash_native: "200",
        price_symbol: "VWCE",
        price_type: "market",
        last_known_price_native: "100",
        cashflows: [{ date: "2023-12-01", amount: "-8000" }],
      },
      {
        symbol: "AGGH",
        name: "Bonds",
        asset_class: "bond",
        broker: "Broker",
        account: "Taxable",
        native_currency: "EUR",
        shares: "50",
        cost_basis_native: "900",
        cumulative_dividends_cash_native: "0",
        price_symbol: "AGGH",
        price_type: "market",
        last_known_price_native: "20",
        cashflows: [{ date: "2023-12-01", amount: "-900" }],
      },
    ],
    portfolio_cashflows: [
      { date: "2023-12-01", amount: "-8000" },
      { date: "2023-12-01", amount: "-900" },
    ],
    cash: [],
    period_openings: {
      month_start_value_eur: "10000",
      year_start_value_eur: "8800",
      holdings: {},
    },
  };
}

describe("buildDashboard overview parity features", () => {
  const eurFx: FxRates = { base: "EUR", rates: { USD: new Decimal("1.10") } };
  const flatQuotes = new Map<string, Quote>([
    ["VWCE", { symbol: "VWCE", price: new Decimal("100"), previousClose: new Decimal("100"), currency: "EUR" }],
    ["AGGH", { symbol: "AGGH", price: new Decimal("20"), previousClose: new Decimal("20"), currency: "EUR" }],
  ]);
  const model = buildDashboard(makePeriodExport(), flatQuotes, eurFx, new Date("2024-06-15T12:00:00Z"));

  it("computes month- and year-to-date growth from the period openings", () => {
    // Value = 100×100 + 50×20 = 11000 EUR; no flows since Jan, so growth is pure.
    approx(model.overview.mtdGrowthPct, (11000 - 10000) / 10000); // +10%
    approx(model.overview.ytdGrowthPct, (11000 - 8800) / 8800); // +25%
  });

  it("computes compounded total growth over the invested lifetime", () => {
    // Single deposit date → compounded growth collapses to the total return.
    approx(model.overview.totalGrowthCompoundedPct, 11000 / 8900 - 1, 2e-3);
  });

  it("computes the trailing dividend yield from per-holding dividend cash", () => {
    approx(model.overview.totalDividendsEur, 200);
    approx(model.overview.dividendYieldPct, 200 / 11000);
  });

  it("surfaces the EUR→USD reference rate", () => {
    expect(model.overview.fxRateEurUsd?.toNumber()).toBeCloseTo(1.1, 6);
  });

  it("builds an allocation by asset class, ordered by value", () => {
    expect(model.allocation.map((s) => s.label)).toEqual(["etf", "bond"]);
    approx(model.allocation[0].weight, 10000 / 11000);
    approx(model.allocation[1].weight, 1000 / 11000);
    const weightSum = model.allocation.reduce((acc, s) => acc + (s.weight?.toNumber() ?? 0), 0);
    expect(weightSum).toBeCloseTo(1, 6);
  });

  it("returns null period growth when no opening value is available", () => {
    const m = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"));
    // makeExport()'s period_openings are zero → no positive base to grow from.
    expect(m.overview.mtdGrowthPct).toBeNull();
    expect(m.overview.ytdGrowthPct).toBeNull();
  });
});
