/**
 * Unit tests for the live computation layer with injected quotes + FX, so they
 * run offline and deterministically.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { buildDashboard, buildFetchPlan, buildMovers, fxTodayDeviationPct, suspectQuoteSymbols } from "../src/compute";
import type { OverviewView } from "../src/compute";
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
        cashflows: [{ date: "2023-01-01", amount: "-909.0909090909091" }],
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
        cashflows: [{ date: "2023-06-01", amount: "-454.5454545454545" }],
      },
    ],
    portfolio_cashflows: [
      { date: "2023-01-01", amount: "-909.0909090909091" },
      { date: "2023-06-01", amount: "-454.5454545454545" },
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

  it("derives a NAV holding's today move from the export when no live quote is served", () => {
    // Regression: a fund the live provider stops serving (e.g. FSKAX) keeps its
    // fresh blob NAV but had no previous close, so it showed no daily move and was
    // excluded from the movers list. With `previous_close_native` in the export it
    // now derives the move from the blob alone — last-known NAV vs prior close.
    const exp = makeExport();
    // FXAIX: fresh NAV 100 (its last_price_date is the export date) vs prior 96.
    exp.holdings[1].last_price_date = "2024-06-01";
    exp.holdings[1].previous_close_native = "96";
    exp.holdings[1].previous_close_date = "2024-05-31";
    // No live quote for FXAIX in `quotes` (only VTI), so it uses the blob.
    const m = buildDashboard(exp, quotes, fx, new Date("2024-06-01T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(false);
    // (100 − 96) × 5 = 20 USD → 18.1818 EUR.
    approx(fxaix.todayMoveEur, 20 / 1.1, 1e-3);
    // pct on the prior value: 4/96.
    approx(fxaix.todayMovePct, 4 / 96, 1e-4);
    // Its move-date matches the freshest peer (VTI, same export date), so it is
    // not flagged stale and so qualifies for the movers leaderboard.
    expect(fxaix.todayMoveIsStale).toBe(false);
    const inMovers = buildMovers(m.holdings).winners.some((w) => w.symbol === "FXAIX");
    expect(inMovers).toBe(true);
  });

  it("does not invent a move when the export lacks a previous close", () => {
    // Older exports (no `previous_close_native`) keep the prior behaviour: a
    // blob-priced NAV holding contributes no daily move rather than a fabricated 0.
    const fxaix = model.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(false);
    expect(fxaix.todayMoveEur).toBeNull();
  });

  it("weights sum to ~1 across priced holdings + cash share", () => {
    const sum = model.holdings.reduce((acc, h) => acc + (h.weight?.toNumber() ?? 0), 0);
    // Holdings weight excludes the cash slice, so it is < 1 but > 0.
    expect(sum).toBeGreaterThan(0.5);
    expect(sum).toBeLessThan(1);
  });

  it("exposes per-holding total growth (compounded; equals P/L ÷ cost for a single buy)", () => {
    // Total growth is now the compounded (1 + XIRR) ^ years figure. For a holding
    // funded by a single contribution that coincides with its cost basis, the
    // compounded figure collapses to the simple P/L ÷ cost ratio, so these
    // single-buy fixtures still line up with the naive ratio (within the XIRR
    // solver's day-count reconstruction).
    for (const holding of model.holdings) {
      if (
        holding.unrealisedPlEur !== null &&
        holding.costBasisEur !== null &&
        holding.costBasisEur.greaterThan(0)
      ) {
        expect(holding.totalGrowthPct).not.toBeNull();
        approx(holding.totalGrowthPct, holding.unrealisedPlEur.dividedBy(holding.costBasisEur).toNumber(), 1e-3);
      }
    }
  });

  it("counts reinvested money-market dividends as gain (growth is not zero)", () => {
    // A money-market fund prices at par ($1) and is never fetched, so its only
    // return is the reinvested dividend. The export now excludes that reinvest
    // from the cost basis, so value (shares × $1) exceeds cost and growth is
    // positive instead of collapsing to zero (desktop + web parity).
    const exp = makeExport();
    exp.holdings = [
      {
        symbol: "VMFXX",
        name: "Vanguard Federal Money Market",
        asset_class: "money_market",
        broker: "Broker",
        account: "Settlement",
        native_currency: "USD",
        shares: "1005",
        cost_basis_native: "1000",
        cumulative_dividends_cash_native: "0",
        price_symbol: "VMFXX",
        price_type: "nav",
        last_known_price_native: "1",
        cashflows: [{ date: "2023-01-01", amount: "-909.0909090909091" }],
      },
    ];
    const m = buildDashboard(exp, new Map(), fx, new Date("2024-06-01T12:00:00Z"));
    const vmfxx = m.holdings.find((h) => h.symbol === "VMFXX")!;
    // 1005 shares × $1 − $1000 cost = $5 of earned dividends.
    expect(vmfxx.unrealisedPlEur!.toNumber()).toBeGreaterThan(0);
    expect(vmfxx.totalGrowthPct).not.toBeNull();
    approx(vmfxx.totalGrowthPct, 0.005, 1e-3);
  });

  it("never shows a daily move for a money-market fund (par NAV)", () => {
    // Even when the export carries a previous close (a repeated $1.00 bar), a
    // money-market fund holds a constant $1.00 NAV and genuinely does not move
    // in price — its today's move must stay blank, not render as 0%.
    const exp = makeExport();
    exp.holdings = [
      {
        symbol: "VMFXX",
        name: "Vanguard Federal Money Market",
        asset_class: "money_market",
        broker: "Broker",
        account: "Settlement",
        native_currency: "USD",
        shares: "1000",
        cost_basis_native: "1000",
        cumulative_dividends_cash_native: "0",
        price_symbol: "VMFXX",
        price_type: "nav",
        last_known_price_native: "1",
        previous_close_native: "1",
        previous_close_date: "2024-05-31",
        cashflows: [{ date: "2023-01-01", amount: "-1000" }],
      },
    ];
    const m = buildDashboard(exp, new Map(), fx, new Date("2024-06-01T12:00:00Z"));
    const vmfxx = m.holdings.find((h) => h.symbol === "VMFXX")!;
    expect(vmfxx.todayMoveEur).toBeNull();
    expect(vmfxx.todayMovePct).toBeNull();
    expect(vmfxx.todayMoveUsd).toBeNull();
    expect(vmfxx.todayMovePctUsd).toBeNull();
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

  it("lets a fresh same-day live NAV override the exported (possibly stale) price", () => {
    // A re-fetch from Twelve Data is the source of truth: when its bar is for the
    // same trading day as the exported price, it must override the exported
    // value so a stale/incorrect figure baked into the blob gets corrected.
    const exp = makeExport();
    exp.meta.as_of = "2024-05-31"; // Friday export, FXAIX last-known 100
    const navQuotes = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("102"), // the real, corrected NAV for the day
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-05-31T20:00:00Z"),
          priceTime: null,
          valueDate: "2024-05-31", // same trading day as the export
        },
      ],
    ]);
    const m = buildDashboard(exp, navQuotes, fx, new Date("2024-05-31T21:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    // Adopted the fresh live NAV (102), not the exported last-known (100).
    expect(fxaix.priceIsLive).toBe(true);
    approx(fxaix.priceNative, 102);
  });

  it("ignores a live NAV bar that is strictly older than the exported price (a closed-day carry-forward)", () => {
    const exp = makeExport();
    exp.meta.as_of = "2024-05-31"; // Friday export
    exp.holdings[1].last_price_date = "2024-05-31"; // exported NAV struck Friday
    const navQuotes = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      // The daily time_series only has an older Thursday bar; adopting it would
      // swap the value backward onto a stale basis, so the export price stands.
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("1"), // older / off-basis value must never be adopted
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-06-03T12:00:00Z"),
          priceTime: null,
          valueDate: "2024-05-30", // Thursday — older than Friday's exported NAV
        },
      ],
    ]);
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
    // A live NAV with a prior daily bar shows a today's move, just like a stock:
    // (110 − 108) × 5 = 10 USD → 9.0909 EUR; pct = 2/108.
    approx(fxaix.todayMoveEur, 10 / 1.1, 1e-3);
    approx(fxaix.todayMovePct, 2 / 108, 1e-4);
  });

  it("shows a NAV fund's latest published move even while it stays on the exported price", () => {
    // A fund publishes ~once a day, so the export usually already carries its
    // newest NAV and the row stays on the exported price (priceIsLive false).
    // It should still surface that last session's move from the prior daily bar
    // — the same way a stock shows last Friday's move over a weekend — instead
    // of a blank dash.
    const exp = makeExport(); // as_of 2024-06-01
    const navQuotes = new Map<string, Quote>([
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("110"),
          previousClose: new Decimal("108"),
          currency: "USD",
          valueDate: "2024-06-01", // current with the exported price
        },
      ],
    ]);
    const m = buildDashboard(exp, navQuotes, fx, new Date("2024-06-01T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(false);
    // Move comes from the fund's own daily bar vs its prior close — the latest
    // published session move: (110 − 108) × 5 = 10 USD → 9.0909 EUR; pct = 2/108.
    approx(fxaix.todayMoveEur, 10 / 1.1, 1e-3);
    approx(fxaix.todayMovePct, 2 / 108, 1e-4);
  });

  it("gives a NAV fund no today's move from a stale, older bar", () => {
    // When the fetched daily bar is *behind* the price we display (its
    // value-date precedes the exported price's date), its previous close is two
    // sessions back and would mislabel an old move as today's — so we show none.
    const exp = makeExport(); // as_of 2024-06-01
    const navQuotes = new Map<string, Quote>([
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("110"),
          previousClose: new Decimal("108"),
          currency: "USD",
          valueDate: "2024-05-30", // older than the exported price's date
        },
      ],
    ]);
    const m = buildDashboard(exp, navQuotes, fx, new Date("2024-06-01T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(false);
    expect(fxaix.todayMoveEur).toBeNull();
    expect(fxaix.todayMovePct).toBeNull();
  });

  it("aggregates the overview move on one global price date instead of summing a lagged NAV session", () => {
    const exp = makeExport();
    exp.meta.as_of = "2024-05-31";
    const mixedQuotes = new Map<string, Quote>([
      [
        "VTI",
        {
          symbol: "VTI",
          price: new Decimal("100"),
          previousClose: new Decimal("95"),
          currency: "USD",
          valueDate: "2024-06-03",
        },
      ],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("110"),
          previousClose: new Decimal("108"),
          currency: "USD",
          valueDate: "2024-05-31",
        },
      ],
    ]);
    const m = buildDashboard(exp, mixedQuotes, fx, new Date("2024-06-03T12:00:00Z"));
    // Desktop methodology values the whole book on 2024-06-03 and the prior
    // global print date. FXAIX has not repriced since 2024-05-31, so its Friday
    // 108→110 move must not leak into Monday's overview move.
    approx(m.overview.todayMoveUsd, 50, 1e-6);
    approx(m.overview.todayMoveEur, 50 / 1.1, 1e-3);
    approx(m.overview.todayMovePctUsd, 50 / (950 + 550 + 220), 1e-4);
    approx(m.overview.todayMovePct, (50 / 1.1) / (950 / 1.1 + 550 / 1.1 + 200), 1e-4);
  });

  it("flags a lagging holding's daily move as stale when a peer has repriced more recently", () => {
    const exp = makeExport();
    exp.meta.as_of = "2024-05-31";
    const mixedQuotes = new Map<string, Quote>([
      [
        "VTI",
        {
          symbol: "VTI",
          price: new Decimal("100"),
          previousClose: new Decimal("95"),
          currency: "USD",
          valueDate: "2024-06-03",
        },
      ],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("110"),
          previousClose: new Decimal("108"),
          currency: "USD",
          valueDate: "2024-05-31",
        },
      ],
    ]);
    const m = buildDashboard(exp, mixedQuotes, fx, new Date("2024-06-03T12:00:00Z"));
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    // VTI printed on the freshest date; FXAIX still sits on the older NAV, so its
    // daily figure is last session's move and must be greyed (stale) — VTI's not.
    expect(vti.todayMoveIsStale).toBe(false);
    expect(fxaix.todayMoveIsStale).toBe(true);
  });

  it("marks no daily move as stale before peers diverge (all on the same close)", () => {
    const exp = makeExport();
    exp.meta.as_of = "2024-05-31";
    const sameDayQuotes = new Map<string, Quote>([
      [
        "VTI",
        {
          symbol: "VTI",
          price: new Decimal("100"),
          previousClose: new Decimal("95"),
          currency: "USD",
          valueDate: "2024-05-31",
        },
      ],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("110"),
          previousClose: new Decimal("108"),
          currency: "USD",
          valueDate: "2024-05-31",
        },
      ],
    ]);
    const m = buildDashboard(exp, sameDayQuotes, fx, new Date("2024-05-31T20:00:00Z"));
    expect(m.holdings.every((h) => !h.todayMoveIsStale)).toBe(true);
  });

  it("keeps FX revaluation on lagged holdings while dropping their stale price move from the overview", () => {
    const exp = makeExport();
    exp.meta.as_of = "2024-05-31";
    exp.cash = [];
    const mixedQuotes = new Map<string, Quote>([
      [
        "VTI",
        {
          symbol: "VTI",
          price: new Decimal("100"),
          previousClose: new Decimal("100"),
          currency: "USD",
          valueDate: "2024-06-03",
        },
      ],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("110"),
          previousClose: new Decimal("108"),
          currency: "USD",
          valueDate: "2024-05-31",
        },
      ],
    ]);
    const m = buildDashboard(exp, mixedQuotes, fx, new Date("2024-06-03T12:00:00Z"), null, {
      fxPrevEurUsd: new Decimal("1.05"),
    });
    // On the 2024-06-03 global step, both holdings keep their current native
    // prices in USD. EUR still feels the FX swing on the whole 1550 USD book, but
    // FXAIX's older 108→110 price move must not be counted again.
    approx(m.overview.todayMoveUsd, 0, 1e-6);
    approx(m.overview.todayMoveEur, 1550 / 1.1 - 1550 / 1.05, 1e-3);
    approx(m.overview.todayFxMoveEur, 1550 / 1.1 - 1550 / 1.05, 1e-3);
  });

  it("shows a fallback NAV's real last-update date (last_price_date), not the export date", () => {
    // Export taken on a Sunday, but FXAIX's NAV last published the prior Friday.
    const exp = makeExport();
    exp.meta.as_of = "2024-06-02"; // Sunday export
    exp.holdings[1].last_price_date = "2024-05-31"; // Friday's NAV strike
    // No live quote for FXAIX → falls back to the exported last-known price.
    const m = buildDashboard(exp, quotes, fx, new Date("2024-06-02T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(false);
    expect(fxaix.priceAsOf).toBeNull();
    // The row dates to when the value was actually updated, not the export day.
    expect(fxaix.priceFallbackDate).toBe("2024-05-31");
  });

  it("falls back to the export date when last_price_date is absent (older exports)", () => {
    const exp = makeExport(); // as_of 2024-06-01, no last_price_date
    const m = buildDashboard(exp, quotes, fx, new Date("2024-06-01T12:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceFallbackDate).toBe("2024-06-01");
  });
});

describe("FX-aware today's move", () => {
  // VTI: 10 shares, price 100, prevClose 95, USD. fxNow = 1.10 USD/EUR.
  it("captures the EUR/USD swing on a USD holding even with a flat price", () => {
    // Price unchanged (prevClose == price) so the price-only move is zero, but
    // EUR/USD strengthened from 1.05 → 1.10, revaluing the whole USD position.
    const flat = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("100"), currency: "USD" }],
    ]);
    const m = buildDashboard(makeExport(), flat, fx, new Date("2024-06-01T12:00:00Z"), null, {
      fxPrevEurUsd: new Decimal("1.05"),
    });
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    // value now = 1000/1.10 = 909.0909; value prev = 1000/1.05 = 952.3809.
    approx(vti.todayMoveEur, 1000 / 1.1 - 1000 / 1.05, 1e-3);
    // The whole move is FX (price didn't move).
    approx(vti.todayFxMoveEur, 1000 / 1.1 - 1000 / 1.05, 1e-3);
    // FX-neutral USD move is zero (no price change).
    approx(vti.todayMoveUsd, 0, 1e-6);
  });

  it("splits a USD holding's move into price and FX parts", () => {
    // Price 95 → 100 (+5×10 = +50 USD) and EUR/USD 1.05 → 1.10.
    const m = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"), null, {
      fxPrevEurUsd: new Decimal("1.05"),
    });
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    // FX-aware EUR move = 1000/1.10 − 950/1.05.
    approx(vti.todayMoveEur, 1000 / 1.1 - 950 / 1.05, 1e-3);
    // FX-neutral USD move = (100−95)×10 = 50 USD.
    approx(vti.todayMoveUsd, 50, 1e-6);
    // Price-only EUR move at today's rate = 50/1.10; FX part is the remainder.
    approx(vti.todayFxMoveEur, 1000 / 1.1 - 950 / 1.05 - 50 / 1.1, 1e-3);
    // Overview now values the whole book on one global step, so it also includes
    // the FX-only revaluation of FXAIX's unchanged 500 USD fallback mark.
    approx(
      m.overview.todayFxMoveEur,
      1000 / 1.1 - 950 / 1.05 - 50 / 1.1 + (500 / 1.1 - 500 / 1.05),
      1e-3,
    );
    expect(m.overview.eurUsdSource).toBe("none"); // not set in opts here
  });

  it("leaves an EUR-native holding unaffected by the EUR/USD swing", () => {
    const exp = makeExport();
    exp.holdings[0].native_currency = "EUR";
    const eurQuotes = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "EUR" }],
    ]);
    const m = buildDashboard(exp, eurQuotes, fx, new Date("2024-06-01T12:00:00Z"), null, {
      fxPrevEurUsd: new Decimal("1.05"),
    });
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    // (100−95)×10 = 50 EUR, no FX component.
    approx(vti.todayMoveEur, 50, 1e-6);
    expect(vti.todayFxMoveEur!.toNumber()).toBeCloseTo(0, 9);
  });

  it("matches the FX-unaware figure when no prior EUR/USD is supplied", () => {
    const withPrev = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"), null, {
      fxPrevEurUsd: new Decimal("1.10"), // prev == now ⇒ no FX swing
    });
    const without = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"));
    approx(withPrev.overview.todayMoveEur, without.overview.todayMoveEur.toNumber(), 1e-9);
    expect(withPrev.holdings[0].todayFxMoveEur!.toNumber()).toBeCloseTo(0, 9);
  });

  it("carries the EUR/USD source label and prior rate for the UI", () => {
    const m = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"), null, {
      fxPrevEurUsd: new Decimal("1.05"),
      fxEurUsdSource: "eod",
    });
    expect(m.overview.eurUsdSource).toBe("eod");
    approx(m.overview.fxRateEurUsdPrev, 1.05, 1e-9);
    // fxRateEurUsd reflects the live spot that valued the marks (fx.rates.USD).
    approx(m.overview.fxRateEurUsd, 1.1, 1e-9);
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

  it("computes the year-to-date dividend yield from the current yearly period", () => {
    const exp = makePeriodExport();
    exp.yearly = {
      rows: [
        {
          label: "2024",
          contributions_eur: "0",
          dividends_eur: "75",
          interest_eur: "0",
          net_flow_eur: "0",
          opening_value_eur: "8800",
          closing_value_eur: "11000",
          growth_pct: null,
        },
      ],
    };
    const m = buildDashboard(exp, flatQuotes, eurFx, new Date("2024-06-15T12:00:00Z"));
    approx(m.overview.totalDividendsEur, 75);
    approx(m.overview.dividendYieldPct, 75 / 11000);
  });

  it("falls back to summing current-year monthly dividends when yearly rows are unavailable", () => {
    const exp = makePeriodExport();
    exp.monthly = {
      rows: [
        {
          label: "2023-12",
          contributions_eur: "0",
          dividends_eur: "999",
          interest_eur: "0",
          net_flow_eur: "0",
          opening_value_eur: "0",
          closing_value_eur: "0",
          growth_pct: null,
        },
        {
          label: "2024-01",
          contributions_eur: "0",
          dividends_eur: "30",
          interest_eur: "0",
          net_flow_eur: "0",
          opening_value_eur: "8800",
          closing_value_eur: "9000",
          growth_pct: null,
        },
        {
          label: "2024-06",
          contributions_eur: "0",
          dividends_eur: "45",
          interest_eur: "0",
          net_flow_eur: "0",
          opening_value_eur: "10000",
          closing_value_eur: "11000",
          growth_pct: null,
        },
      ],
    };
    const m = buildDashboard(exp, flatQuotes, eurFx, new Date("2024-06-15T12:00:00Z"));
    approx(m.overview.totalDividendsEur, 75);
  });

  it("uses zero year-to-date dividends when the current yearly row is absent", () => {
    const exp = makePeriodExport();
    exp.yearly = {
      rows: [
        {
          label: "2023",
          contributions_eur: "0",
          dividends_eur: "999",
          interest_eur: "0",
          net_flow_eur: "0",
          opening_value_eur: "0",
          closing_value_eur: "8800",
          growth_pct: null,
        },
      ],
    };
    const m = buildDashboard(exp, flatQuotes, eurFx, new Date("2024-06-15T12:00:00Z"));
    approx(m.overview.totalDividendsEur, 0);
    approx(m.overview.dividendYieldPct, 0);
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

  it("carries each ticker's native currency (C2), and null when holdings disagree", () => {
    const data = planExport();
    // Two holdings on one ticker that disagree on currency → collapses to null.
    data.holdings.push({
      ...data.holdings[0],
      symbol: "BIG_ETF_EUR_LEG",
      price_symbol: "BIG_ETF",
      asset_class: "etf",
      price_type: "market",
      native_currency: "EUR",
    });
    const plan = buildFetchPlan(data, new Set(["mutual_fund"]));
    const small = plan.find((e) => e.symbol === "SMALL_ETF");
    const big = plan.find((e) => e.symbol === "BIG_ETF");
    expect(small?.nativeCurrency).toBe("USD");
    expect(big?.nativeCurrency).toBeNull();
  });

  it("excludes money-market funds even when they carry the mutual_fund class (VMFXX)", () => {
    // The desktop keeps settlement funds in the broad mutual_fund class, so the
    // asset_class alone won't exclude them; they must be caught by ticker/flag.
    const data = planExport();
    data.holdings.push({
      ...data.holdings[0],
      symbol: "VMFXX",
      price_symbol: "VMFXX",
      asset_class: "mutual_fund",
      price_type: "nav",
    });
    data.period_openings.holdings.VMFXX = { month_start_value_eur: "8000", year_start_value_eur: "8000" };
    const byTicker = buildFetchPlan(data, new Set(["mutual_fund"]));
    expect(byTicker.map((e) => e.symbol)).not.toContain("VMFXX");

    // And via the explicit export flag (e.g. a renamed/unknown settlement fund).
    const flagged = planExport();
    flagged.holdings.push({
      ...flagged.holdings[0],
      symbol: "CASHX",
      price_symbol: "CASHX",
      asset_class: "mutual_fund",
      price_type: "nav",
      is_money_market: true,
    });
    flagged.period_openings.holdings.CASHX = { month_start_value_eur: "8000", year_start_value_eur: "8000" };
    const flagPlan = buildFetchPlan(flagged, new Set(["mutual_fund"]));
    expect(flagPlan.map((e) => e.symbol)).not.toContain("CASHX");
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

/**
 * Currency-dependent growth: when the EUR→USD rate has drifted between the
 * purchase dates and now, EUR-denominated and USD-denominated growth genuinely
 * differ. The compute layer must expose both so the UI can pick per currency.
 */
function makeUsdExport(): MobileExport {
  return {
    meta: {
      schema_version: 1,
      app_version: "test",
      generated_at: "2024-06-01T00:00:00+00:00",
      as_of: "2024-06-01",
      display_currency: "EUR",
      fx_pivot: "EUR",
      fx_rate_eur_usd: "1.20",
      currency_note: "test",
    },
    holdings: [
      {
        symbol: "EURO",
        name: "Euro Fund",
        asset_class: "etf",
        broker: "Broker",
        account: "Taxable",
        native_currency: "EUR",
        shares: "10",
        cost_basis_native: "1000",
        cost_basis_usd: "1100",
        cumulative_dividends_cash_native: "0",
        price_symbol: "EURO",
        price_type: "market",
        last_known_price_native: "120",
        cashflows: [{ date: "2023-01-01", amount: "-1000", amount_usd: "-1100" }],
      },
    ],
    portfolio_cashflows: [{ date: "2023-01-01", amount: "-1000", amount_usd: "-1100" }],
    cash: [],
    period_openings: {
      month_start_value_eur: "0",
      year_start_value_eur: "0",
      holdings: {},
    },
  };
}

describe("currency-dependent growth", () => {
  // EUR strengthened: bought at 1.10 (cost 1000 EUR = 1100 USD), now 1.20.
  const fxNow: FxRates = { base: "EUR", rates: { USD: new Decimal("1.20") } };
  const usdQuotes = new Map<string, Quote>([
    ["EURO", { symbol: "EURO", price: new Decimal("120"), previousClose: new Decimal("120"), currency: "EUR" }],
  ]);
  const m = buildDashboard(makeUsdExport(), usdQuotes, fxNow, new Date("2024-06-01T12:00:00Z"));

  it("reports different EUR and USD total growth", () => {
    // Value 1200 EUR. EUR gain = 200 / 1000 = 20%.
    approx(m.overview.totalGainPct, 0.2, 1e-4);
    // Value in USD = 1200 × 1.20 = 1440; USD gain = 340 / 1100 = 30.91%.
    approx(m.overview.totalGainPctUsd, 340 / 1100, 1e-4);
  });

  it("reports per-holding USD growth distinct from EUR", () => {
    const h = m.holdings[0];
    // Compounded (1 + XIRR) ^ years growth; for this single buy it tracks the
    // simple gain ratio within the XIRR solver's day-count reconstruction.
    approx(h.totalGrowthPct, 0.2, 1e-3);
    approx(h.totalGrowthPctUsd, 340 / 1100, 1e-3);
    expect(h.costBasisUsd?.toNumber()).toBeCloseTo(1100, 4);
    expect(h.valueUsd?.toNumber()).toBeCloseTo(1440, 4);
  });

  it("computes a USD XIRR that differs from the EUR XIRR", () => {
    expect(m.overview.portfolioXirr).not.toBeNull();
    expect(m.overview.portfolioXirrUsd).not.toBeNull();
    expect(m.overview.portfolioXirrUsd!.toNumber()).not.toBeCloseTo(
      m.overview.portfolioXirr!.toNumber(),
      4,
    );
  });
});

describe("compounded total growth vs simple ratio (multi-flow)", () => {
  // The user-reported defect: a holding funded by regular, repeated buys whose
  // latest contributions have barely had time to grow read a deflated simple
  // gain/cost ratio. With multiple cashflows the compounded (1 + XIRR) ^ years
  // figure genuinely diverges from the naive ratio, so the row must report the
  // compounded number rather than falling back to gain/cost.
  function makeDcaExport(): MobileExport {
    return {
      meta: {
        schema_version: 1,
        app_version: "test",
        generated_at: "2024-06-01T00:00:00+00:00",
        as_of: "2024-06-01",
        display_currency: "EUR",
        fx_pivot: "EUR",
        fx_rate_eur_usd: "1.00",
        currency_note: "test",
      },
      holdings: [
        {
          symbol: "DCA",
          name: "Dollar Cost Average",
          asset_class: "etf",
          broker: "Broker",
          account: "Taxable",
          native_currency: "EUR",
          shares: "20",
          cost_basis_native: "2200",
          cumulative_dividends_cash_native: "0",
          price_symbol: "DCA",
          price_type: "market",
          last_known_price_native: "150",
          // Two buys a year apart: an old 1000 and a recent 1200.
          cashflows: [
            { date: "2023-01-05", amount: "-1000" },
            { date: "2024-01-05", amount: "-1200" },
          ],
        },
      ],
      portfolio_cashflows: [
        { date: "2023-01-05", amount: "-1000" },
        { date: "2024-01-05", amount: "-1200" },
      ],
      cash: [],
      period_openings: { month_start_value_eur: "0", year_start_value_eur: "0", holdings: {} },
    };
  }

  it("reports the compounded growth, not the deflated gain/cost ratio", () => {
    const noFx: FxRates = { base: "EUR", rates: { USD: new Decimal("1.00") } };
    const quotes = new Map<string, Quote>([
      ["DCA", { symbol: "DCA", price: new Decimal("150"), previousClose: new Decimal("150"), currency: "EUR" }],
    ]);
    const model = buildDashboard(makeDcaExport(), quotes, noFx, new Date("2024-06-01T12:00:00Z"));
    const h = model.holdings[0];
    // Value 20 × 150 = 3000, cost 2200 ⇒ the simple ratio would be 800 / 2200.
    const simpleRatio = 800 / 2200;
    expect(h.totalGrowthPct).not.toBeNull();
    expect(h.totalGrowthPct!.toNumber()).toBeGreaterThan(0);
    // Compounded growth is a real profit but is NOT the naive gain/cost ratio.
    expect(Math.abs(h.totalGrowthPct!.toNumber() - simpleRatio)).toBeGreaterThan(0.01);
  });
});

describe("fxTodayDeviationPct", () => {
  it("reports the EUR/USD move as a signed fraction vs. the prior close", () => {
    const o = {
      fxRateEurUsd: new Decimal("1.1033"),
      fxRateEurUsdPrev: new Decimal("1.10"),
    } as unknown as OverviewView;
    approx(fxTodayDeviationPct(o), (1.1033 - 1.10) / 1.10, 1e-6);
  });

  it("is null when either rate is unknown or the prior close is non-positive", () => {
    expect(fxTodayDeviationPct({ fxRateEurUsd: null, fxRateEurUsdPrev: new Decimal("1.1") } as unknown as OverviewView)).toBeNull();
    expect(fxTodayDeviationPct({ fxRateEurUsd: new Decimal("1.1"), fxRateEurUsdPrev: null } as unknown as OverviewView)).toBeNull();
    expect(fxTodayDeviationPct({ fxRateEurUsd: new Decimal("1.1"), fxRateEurUsdPrev: new Decimal("0") } as unknown as OverviewView)).toBeNull();
  });
});

describe("cost_basis_eur trade-date path", () => {
  it("uses the exported per-trade-date EUR cost basis when present", () => {
    const exp = makeExport();
    // The buy cost 1000 USD but only 800 EUR at the (stronger-dollar) trade date.
    exp.holdings[0].cost_basis_eur = "800";
    const m = buildDashboard(exp, quotes, fx, new Date("2024-06-01T12:00:00Z"));
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    approx(vti.costBasisEur, 800);
  });

  it("falls back to converting native cost at today's spot when absent", () => {
    const m = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"));
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    // 1000 USD / 1.10 = 909.09 EUR.
    approx(vti.costBasisEur, 1000 / 1.1, 1e-2);
  });
});

describe("EUR vs USD growth genuinely diverge (regression for identical figures)", () => {
  // The desktop exports per-trade-date cost bases AND per-trade-date cashflow
  // legs in BOTH currencies. When the historical FX rate differs from today's
  // spot the per-currency growth numbers must NOT collapse to one value.
  // Build a holding bought when the dollar was much weaker: 900 EUR == 1100 USD
  // at the trade date (rate 1.222), today's spot is 1.10.
  function divergentExport(): MobileExport {
    const exp = makeExport();
    exp.holdings[0].cashflows = [{ date: "2023-01-01", amount: "-900", amount_usd: "-1100" }];
    exp.holdings[0].cost_basis_eur = "900";
    exp.holdings[0].cost_basis_usd = "1100";
    return exp;
  }

  it("per-holding total growth differs between EUR and USD", () => {
    const m = buildDashboard(divergentExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"));
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    expect(vti.totalGrowthPct).not.toBeNull();
    expect(vti.totalGrowthPctUsd).not.toBeNull();
    expect(
      Math.abs(vti.totalGrowthPct!.toNumber() - vti.totalGrowthPctUsd!.toNumber()),
    ).toBeGreaterThan(0.01);
  });

  it("portfolio total gain % differs between EUR and USD", () => {
    const m = buildDashboard(divergentExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"));
    const o = m.overview;
    expect(o.totalGainPct).not.toBeNull();
    expect(o.totalGainPctUsd).not.toBeNull();
    expect(Math.abs(o.totalGainPct!.toNumber() - o.totalGainPctUsd!.toNumber())).toBeGreaterThan(0.01);
  });
});

describe("pricesAreLive honesty", () => {
  // A weekday inside the NYSE regular session (Mon 2024-06-03, 10:00 ET).
  const openNow = new Date("2024-06-03T14:00:00Z");

  function liveQuotes(over: Partial<Quote> = {}): Map<string, Quote> {
    return new Map<string, Quote>([
      [
        "VTI",
        {
          symbol: "VTI",
          price: new Decimal("100"),
          previousClose: new Decimal("95"),
          currency: "USD",
          at: openNow.getTime(),
          ...over,
        },
      ],
    ]);
  }

  it("is live when the market is open and a fresh quote just landed", () => {
    const m = buildDashboard(makeExport(), liveQuotes(), fx, openNow);
    expect(m.overview.pricesAreLive).toBe(true);
  });

  it("is not live when the market is closed (weekend), even with a fresh quote", () => {
    const sat = new Date("2024-06-01T14:00:00Z");
    const m = buildDashboard(makeExport(), liveQuotes({ at: sat.getTime() }), fx, sat);
    expect(m.overview.pricesAreLive).toBe(false);
  });

  it("is not live on a market holiday (Juneteenth), even during session hours", () => {
    const juneteenth = new Date("2024-06-19T14:00:00Z");
    const m = buildDashboard(makeExport(), liveQuotes({ at: juneteenth.getTime() }), fx, juneteenth);
    expect(m.overview.pricesAreLive).toBe(false);
  });

  it("is not live when the freshest quote is stale (feed unreachable)", () => {
    // The cached quote is 20 minutes old — beyond the live window — so even
    // though the market is open we can no longer claim a live price.
    const stale = openNow.getTime() - 20 * 60 * 1000;
    const m = buildDashboard(makeExport(), liveQuotes({ at: stale }), fx, openNow);
    expect(m.overview.pricesAreLive).toBe(false);
  });

  it("is not live when the provider reports the market closed (is_market_open=false)", () => {
    // Twelve Data's own ground truth overrides our modelled open session — e.g.
    // an unscheduled close or an early half-day close the calendar misses.
    const m = buildDashboard(makeExport(), liveQuotes({ marketOpen: false }), fx, openNow);
    expect(m.overview.pricesAreLive).toBe(false);
  });

  it("stays live when the provider confirms the market is open", () => {
    const m = buildDashboard(makeExport(), liveQuotes({ marketOpen: true }), fx, openNow);
    expect(m.overview.pricesAreLive).toBe(true);
  });

  it("ties the live window to the configured refresh interval (tightens it)", () => {
    // A quote 5 minutes old is "live" under the default 15-min window, but a
    // 2-minute auto-refresh interval narrows the window so it no longer reads
    // live — freshness tracks the cadence set in settings.
    const fiveMinAgo = openNow.getTime() - 5 * 60 * 1000;
    const quotes = liveQuotes({ at: fiveMinAgo });
    expect(buildDashboard(makeExport(), quotes, fx, openNow).overview.pricesAreLive).toBe(true);
    const tight = buildDashboard(makeExport(), quotes, fx, openNow, null, {
      liveStalenessMs: 2 * 60 * 1000,
    });
    expect(tight.overview.pricesAreLive).toBe(false);
  });

  it("ties the live window to the configured refresh interval (widens it)", () => {
    // A quote 20 minutes old is stale under the default window, but a 30-min
    // auto-refresh interval widens the window so it still reads live.
    const twentyMinAgo = openNow.getTime() - 20 * 60 * 1000;
    const quotes = liveQuotes({ at: twentyMinAgo });
    expect(buildDashboard(makeExport(), quotes, fx, openNow).overview.pricesAreLive).toBe(false);
    const wide = buildDashboard(makeExport(), quotes, fx, openNow, null, {
      liveStalenessMs: 30 * 60 * 1000,
    });
    expect(wide.overview.pricesAreLive).toBe(true);
  });
});

describe("USD total is native (holding prices added together), EUR derived via the live rate", () => {
  // A pure USD-priced book with no cash, so the USD total is *exactly* the sum
  // of the holding prices and never touches FX. The user's invariant: logging in
  // repeatedly while the market is closed but the EUR/USD rate drifts must show
  // the SAME USD value every time, yet a different EUR value.
  function usdOnlyExport(): MobileExport {
    const exp = makeExport();
    exp.cash = []; // drop the EUR cash leg so only USD holdings remain
    return exp;
  }

  const usdQuotes = new Map<string, Quote>([
    ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
    // FXAIX falls back to last_known_price_native = 100 → 5 × 100 = 500 USD.
  ]);

  const weakDollar: FxRates = { base: "EUR", rates: { USD: new Decimal("1.10") } };
  const strongDollar: FxRates = { base: "EUR", rates: { USD: new Decimal("1.25") } };

  it("keeps the USD total identical when only the FX rate moves, but changes EUR", () => {
    const at = new Date("2024-06-01T12:00:00Z");
    const a = buildDashboard(usdOnlyExport(), usdQuotes, weakDollar, at);
    const b = buildDashboard(usdOnlyExport(), usdQuotes, strongDollar, at);
    // VTI 10 × 100 = 1000 USD, FXAIX 5 × 100 = 500 USD → 1500 USD, FX-free.
    approx(a.overview.totalValueUsd, 1500, 1e-9);
    approx(b.overview.totalValueUsd, 1500, 1e-9);
    // EUR is USD ÷ the live rate, so it genuinely differs between the two logins.
    approx(a.overview.totalValueEur, 1500 / 1.1, 1e-3);
    approx(b.overview.totalValueEur, 1500 / 1.25, 1e-3);
    expect(a.overview.totalValueEur!.equals(b.overview.totalValueEur!)).toBe(false);
  });

  it("values each USD holding FX-free (exactly shares × price)", () => {
    const m = buildDashboard(usdOnlyExport(), usdQuotes, strongDollar, new Date("2024-06-01T12:00:00Z"));
    const vti = m.holdings.find((h) => h.symbol === "VTI")!;
    expect(vti.valueUsd!.toString()).toBe("1000");
    // EUR = 1000 / 1.25 = 800, the live-rate conversion.
    approx(vti.valueEur, 800, 1e-9);
  });
});

describe("fxObservedAt", () => {
  it("surfaces the FX observation time passed through the build options", () => {
    const observedAt = Date.UTC(2024, 5, 1, 11, 30);
    const m = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"), null, {
      fxObservedAt: observedAt,
    });
    expect(m.overview.fxObservedAt).toBe(observedAt);
  });

  it("defaults to null when no FX observation time is provided", () => {
    const m = buildDashboard(makeExport(), quotes, fx, new Date("2024-06-01T12:00:00Z"));
    expect(m.overview.fxObservedAt).toBeNull();
  });
});

describe("C5 — bars-first NAV headline (bar-tip equals the quote-derived total)", () => {
  // A NAV primed from a settled daily bar (primeQuotesFromBars with the NAV
  // value-date stamp) looks exactly like this: value-dated, marketOpen:false,
  // priceTime at the bar's day-start. The headline must adopt it, matching what a
  // conventional NAV *quote* of the same value would have produced.
  const barDay = Date.parse("2024-06-03T00:00:00Z");
  const exp = (() => {
    const e = makeExport();
    e.meta.as_of = "2024-05-31"; // export older than the settled bar day
    return e;
  })();

  it("adopts a value-dated NAV bar tip as the headline NAV (not the export fallback)", () => {
    const navFromBar = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("103"),
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-06-03T12:00:00Z"),
          priceTime: barDay,
          valueDate: "2024-06-03",
          marketOpen: false,
        },
      ],
    ]);
    const m = buildDashboard(exp, navFromBar, fx, new Date("2024-06-03T18:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(true);
    approx(fxaix.priceNative, 103);

    // The same value supplied as a conventional NAV quote yields the same total —
    // i.e. bars-first costs nothing in correctness, it only saves a quote credit.
    const navFromQuote = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("103"),
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-06-03T20:00:00Z"),
          priceTime: null,
          valueDate: "2024-06-03",
        },
      ],
    ]);
    const m2 = buildDashboard(exp, navFromQuote, fx, new Date("2024-06-03T18:00:00Z"));
    approx(m.overview.totalValueEur, (m2.overview.totalValueEur as Decimal).toNumber(), 1e-6);
  });

  it("rejects a NAV bar tip with no value-date (falls back to the exported price)", () => {
    // Without the C5 value-date stamp a bar-primed NAV is treated as stale and the
    // headline keeps the exported last-known price — proving the stamp is required.
    const navNoDate = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" }],
      [
        "FXAIX",
        {
          symbol: "FXAIX",
          price: new Decimal("103"),
          previousClose: null,
          currency: "USD",
          at: Date.parse("2024-06-03T12:00:00Z"),
          priceTime: barDay,
          valueDate: null,
        },
      ],
    ]);
    const m = buildDashboard(exp, navNoDate, fx, new Date("2024-06-03T18:00:00Z"));
    const fxaix = m.holdings.find((h) => h.symbol === "FXAIX")!;
    expect(fxaix.priceIsLive).toBe(false);
    approx(fxaix.priceNative, 100); // exported last-known, not the dateless bar
  });
});

describe("suspectQuoteSymbols", () => {
  const q = (symbol: string, price: number | null): Quote => ({
    symbol,
    price: price === null ? null : new Decimal(price),
    previousClose: null,
    currency: "USD",
    at: null,
    priceTime: null,
    valueDate: null,
  });

  it("flags only freshly-fetched symbols whose price is non-positive", () => {
    const quotes = new Map<string, Quote>([
      ["AAPL", q("AAPL", 187.5)],
      ["BAD0", q("BAD0", 0)],
      ["NEG", q("NEG", -3)],
      ["NULL", q("NULL", null)],
    ]);
    // Only symbols actually fetched this round are considered.
    expect(suspectQuoteSymbols(quotes, ["AAPL", "BAD0", "NEG", "NULL"])).toEqual(["BAD0", "NEG"]);
    expect(suspectQuoteSymbols(quotes, ["AAPL"])).toEqual([]);
    // A null price is "no data", not "wrong data": never suspect.
    expect(suspectQuoteSymbols(quotes, ["NULL"])).toEqual([]);
  });
});
