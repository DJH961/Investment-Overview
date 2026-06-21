/**
 * Unit tests for the live computation layer with injected quotes + FX, so they
 * run offline and deterministically.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { buildDashboard, buildFetchPlan } from "../src/compute";
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

  it("exposes per-holding price freshness (live timestamp vs. export fallback)", () => {
    const at = 1_717_243_200_000; // 2024-06-01T12:00:00Z
    const stamped = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD", at }],
    ]);
    const m = buildDashboard(makeExport(), stamped, fx, new Date("2024-06-01T12:00:00Z"));
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    // Live/cached price carries its observation time; export fallback is null
    // but still advertises the export's valuation date for the UI to show.
    expect(vti.priceAsOf).toBe(at);
    expect(fxaix.priceAsOf).toBeNull();
    expect(fxaix.priceFallbackDate).toBe("2024-06-01");
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

  it("falls back to the last exported value when a holding has no live price", () => {
    const exp = makeExport();
    // No live quote and no last-known price, but a value was exported for it.
    exp.holdings[1].last_known_price_native = null;
    exp.analytics = makeAnalyticsWith([{ symbol: "FXAIX", end_value: "500" }]);
    const m = buildDashboard(exp, quotes, fx, new Date("2024-06-01T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.valueIsStale).toBe(true);
    approx(fxaix.valueEur, 500);
    // Recovered, so it no longer drops out and the total is complete again.
    expect(m.overview.missingPriceSymbols).toEqual([]);
    expect(m.overview.staleValueSymbols).toEqual(["FXAIX"]);
    expect(m.overview.totalValueIsComplete).toBe(true);
  });

  it("falls back to the last exported value when the FX leg is missing", () => {
    const noFx: FxRates = { base: "EUR", rates: {} };
    const exp = makeExport();
    exp.analytics = makeAnalyticsWith([
      { symbol: "VTI", end_value: "909" },
      { symbol: "FXAIX", end_value: "454" },
    ]);
    const m = buildDashboard(exp, quotes, noFx, new Date("2024-06-01T12:00:00Z"));
    expect(m.overview.fxMissingCurrencies).toEqual([]);
    expect(m.overview.staleValueSymbols).toEqual(["VTI", "FXAIX"]);
    expect(m.overview.totalValueIsComplete).toBe(true);
    approx(m.overview.totalValueEur, 909 + 454 + 200);
  });
  it("shows a NAV holding's real strike time, not the fetch time, as its price as-of", () => {
    const priceTime = Date.parse("2024-05-31T20:00:00Z"); // yesterday's NAV strike
    const navQuotes = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      // A genuinely newer NAV (value-date after the export) with its own strike time.
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("101"),
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-06-01T12:00:00Z"), // fetched "now"
          priceTime, // but the NAV actually struck yesterday evening
          valueDate: "2024-05-31",
        },
      ],
    ]);
    // Export as_of is 2024-06-01, so a 2024-05-31 NAV is NOT newer → kept as
    // last-known (consistent basis); but if it WERE newer we'd surface priceTime.
    const expNewer = makeExport();
    expNewer.meta.as_of = "2024-05-30"; // make the fetched NAV strictly newer
    const m = buildDashboard(expNewer, navQuotes, fx, new Date("2024-06-01T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(true);
    // The as-of reflects the price's real strike time, not the fetch time.
    expect(fxaix.priceAsOf).toBe(priceTime);
  });

  it("does not let a same-or-older live NAV override the consistent exported price", () => {
    const exp = makeExport(); // as_of 2024-06-01
    const navQuotes = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      // A live NAV whose value-date is NOT newer than the export, and on a wildly
      // different (wrong) basis — must be ignored to avoid cratering the total.
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("1"), // bogus / off-basis NAV
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-06-01T12:00:00Z"),
          priceTime: Date.parse("2024-06-01T00:00:00Z"),
          valueDate: "2024-06-01", // same day as export → not newer
        },
      ],
    ]);
    const m = buildDashboard(exp, navQuotes, fx, new Date("2024-06-01T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    // Kept the exported last-known price (100), not the bogus live 1.
    expect(fxaix.priceIsLive).toBe(false);
    approx(fxaix.priceNative, 100);
    approx(fxaix.valueEur, (5 * 100) / 1.1, 1e-3);
  });

  it("ignores a NAV value-date that is not newer than the export (e.g. a mid-week holiday carry-forward)", () => {
    const exp = makeExport();
    exp.meta.as_of = "2024-05-31"; // Friday export
    const navQuotes = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      // The daily time_series has no bar for a closed day, so the latest NAV bar
      // is still Friday's — not newer than the export, so the export price stands.
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("1"), // off-basis value must never be adopted
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-06-03T12:00:00Z"),
          priceTime: null,
          valueDate: "2024-05-31", // same trading day as the export
        },
      ],
    ]);
    // Monday 2024-06-03 (imagine a holiday); no newer NAV has published.
    const m = buildDashboard(exp, navQuotes, fx, new Date("2024-06-03T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(false);
    approx(fxaix.priceNative, 100);
  });

  it("adopts a genuinely newer NAV bar and shows its value-date (not the fetch time)", () => {
    const exp = makeExport();
    exp.meta.as_of = "2024-05-30"; // Thursday export
    const navQuotes = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("110"),
          previousClose: new Decimal("108"),
          currency: "USD",
          at: Date.parse("2024-06-03T12:00:00Z"),
          priceTime: null, // daily bar: no intraday time
          valueDate: "2024-05-31", // Friday — newer than the Thursday export
        },
      ],
    ]);
    const m = buildDashboard(exp, navQuotes, fx, new Date("2024-06-03T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(true);
    approx(fxaix.priceNative, 110);
    // No intraday strike time → the row shows the NAV's value-date as a date.
    expect(fxaix.priceAsOf).toBeNull();
    expect(fxaix.priceFallbackDate).toBe("2024-05-31");
  });
});

function makeAnalyticsWith(
  rows: Array<{ symbol: string; end_value: string }>,
): MobileExport["analytics"] {
  return {
    as_of: "2024-06-01",
    start: "2023-01-01",
    currency: "EUR",
    cagr: null,
    twr: null,
    xirr: null,
    volatility: null,
    sharpe: null,
    sortino: null,
    max_drawdown: null,
    calmar: null,
    ulcer: null,
    var_95: null,
    cvar_95: null,
    skew: null,
    kurtosis: null,
    beta: null,
    alpha: null,
    risk_free_rate: null,
    risk_free_symbol: null,
    benchmark_symbol: null,
    curve: [],
    attribution: rows.map((r, i) => ({
      instrument_id: i + 1,
      symbol: r.symbol,
      start_value: null,
      end_value: r.end_value,
      net_contribution: null,
      absolute_pnl: null,
      pct_of_total_return: null,
    })),
  };
}

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

describe("buildFetchPlan", () => {
  function planExport(): MobileExport {
    const base = makeExport();
    base.holdings = [
      { ...base.holdings[0], symbol: "SMALL_ETF", price_symbol: "SMALL_ETF", asset_class: "etf", price_type: "market" },
      { ...base.holdings[0], symbol: "BIG_ETF", price_symbol: "BIG_ETF", asset_class: "etf", price_type: "market" },
      { ...base.holdings[1], symbol: "BIG_FUND", price_symbol: "BIG_FUND", asset_class: "mutual_fund", price_type: "nav" },
      { ...base.holdings[1], symbol: "SMALL_FUND", price_symbol: "SMALL_FUND", asset_class: "mutual_fund", price_type: "nav" },
      { ...base.holdings[1], symbol: "MMF", price_symbol: "MMF", asset_class: "money_market", price_type: "nav" },
    ];
    base.period_openings = {
      month_start_value_eur: "0",
      year_start_value_eur: "0",
      holdings: {
        SMALL_ETF: { month_start_value_eur: "100", year_start_value_eur: "100" },
        BIG_ETF: { month_start_value_eur: "9000", year_start_value_eur: "9000" },
        BIG_FUND: { month_start_value_eur: "5000", year_start_value_eur: "5000" },
        SMALL_FUND: { month_start_value_eur: "50", year_start_value_eur: "50" },
        MMF: { month_start_value_eur: "9999", year_start_value_eur: "9999" },
      },
    };
    return base;
  }

  it("orders ETFs/stocks first (largest first), then mutual funds (largest first)", () => {
    const plan = buildFetchPlan(planExport(), new Set(["mutual_fund"]));
    expect(plan.map((e) => e.symbol)).toEqual(["BIG_ETF", "SMALL_ETF", "BIG_FUND", "SMALL_FUND"]);
  });

  it("excludes money-market (never-requested) holdings", () => {
    const plan = buildFetchPlan(planExport(), new Set(["mutual_fund"]));
    expect(plan.map((e) => e.symbol)).not.toContain("MMF");
  });

  it("aggregates size across holdings sharing one ticker and prefers market priority", () => {
    const data = planExport();
    // A second holding on BIG_FUND's ticker, but market-priced and large.
    data.holdings.push({
      ...data.holdings[0],
      symbol: "DUP",
      price_symbol: "BIG_FUND",
      asset_class: "etf",
      price_type: "market",
    });
    data.period_openings.holdings.DUP = { month_start_value_eur: "1", year_start_value_eur: "1" };
    const plan = buildFetchPlan(data, new Set(["mutual_fund"]));
    const bigFund = plan.find((e) => e.symbol === "BIG_FUND")!;
    // Market priority wins, so the ticker now ranks among the market group.
    expect(bigFund.priceType).toBe("market");
    expect(bigFund.sizeEur).toBe(5001);
  });
});
