/**
 * The 1D graph's dashed "Prev close" line reads the compute layer's *settled*
 * prior-close anchor (`prevCloseAnchorEur/Usd`) rather than the live
 * `totalValue − todayMove`. Because Twelve Data's free tier defers some symbols
 * across several polls, the old derivation re-classified each holding as its quote
 * landed and re-valued the rest at the drifting live EUR/USD — so the flat
 * reference line visibly walked between updates. The anchor instead sums each
 * holding's own settled prior close, frozen at the settled prior FX and
 * independent of which quotes happen to be warm, so it stays put while only the
 * live tip moves.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { buildDashboard } from "../src/compute";
import type { FxRates, Quote } from "../src/prices";
import type { MobileExport } from "../src/types";

/** Two USD market holdings + EUR cash, so deferral genuinely matters. */
function makeExport(): MobileExport {
  return {
    meta: {
      schema_version: 1,
      app_version: "test",
      generated_at: "2024-06-03T00:00:00+00:00",
      as_of: "2024-06-03",
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
        // The displayed close when no fresh quote has arrived == yesterday's close,
        // which equals the quote's `previous_close` below, so the anchor is
        // continuous as the deferred quote lands.
        last_known_price_native: "95",
        cashflows: [{ date: "2023-01-01", amount: "-909.09" }],
      },
      {
        symbol: "SCHB",
        name: "Schwab Broad Market",
        asset_class: "etf",
        broker: "Broker",
        account: "Taxable",
        native_currency: "USD",
        shares: "5",
        cost_basis_native: "500",
        cumulative_dividends_cash_native: "0",
        price_symbol: "SCHB",
        price_type: "market",
        last_known_price_native: "100",
        cashflows: [{ date: "2023-06-01", amount: "-454.54" }],
      },
    ],
    portfolio_cashflows: [
      { date: "2023-01-01", amount: "-909.09" },
      { date: "2023-06-01", amount: "-454.54" },
    ],
    cash: [{ account_label: "Direct", broker: "Bank", native_currency: "EUR", balance_native: "200" }],
    period_openings: { month_start_value_eur: "0", year_start_value_eur: "0", holdings: {} },
  };
}

const fxLive: FxRates = { base: "EUR", rates: { USD: new Decimal("1.10") } };
const FX_PREV = new Decimal("1.08");
const NOW = new Date("2024-06-03T17:00:00Z");

const quoteVti: Quote = { symbol: "VTI", price: new Decimal("100"), previousClose: new Decimal("95"), currency: "USD" };
const quoteSchb: Quote = { symbol: "SCHB", price: new Decimal("103"), previousClose: new Decimal("100"), currency: "USD" };

/** Anchor with both quotes present (the fully-loaded reference). */
function fullyLoaded() {
  return buildDashboard(makeExport(), new Map([["VTI", quoteVti], ["SCHB", quoteSchb]]), fxLive, NOW, null, {
    fxPrevEurUsd: FX_PREV,
  }).overview;
}

describe("prevCloseAnchor — settled, session-stable", () => {
  it("is invariant across free-tier deferral polls and matches the fully-loaded value", () => {
    // Poll 1: only VTI's quote has arrived; SCHB is still deferred and shows its
    // exported close (= yesterday). Poll 2: SCHB's quote lands too.
    const poll1 = buildDashboard(makeExport(), new Map([["VTI", quoteVti]]), fxLive, NOW, null, { fxPrevEurUsd: FX_PREV }).overview;
    const poll2 = fullyLoaded();

    // The dashed line does not move as the deferred quote arrives.
    expect(poll1.prevCloseAnchorEur.toFixed(4)).toBe(poll2.prevCloseAnchorEur.toFixed(4));
    expect(poll1.prevCloseAnchorUsd!.toFixed(4)).toBe(poll2.prevCloseAnchorUsd!.toFixed(4));

    // …and it equals the genuine settled prior close: (95·10 + 100·5) USD at the
    // settled prior FX, plus 200 EUR cash.
    const expectedEur = new Decimal("950").plus("500").dividedBy(FX_PREV).plus("200");
    expect(poll2.prevCloseAnchorEur.toFixed(4)).toBe(expectedEur.toFixed(4));
    // USD anchor: the native prior-close sum (FX-free) plus the EUR cash revalued
    // at the settled prior FX (200 EUR · 1.08 = 216 USD).
    const expectedUsd = new Decimal("1450").plus(new Decimal("200").times(FX_PREV));
    expect(poll2.prevCloseAnchorUsd!.toFixed(4)).toBe(expectedUsd.toFixed(4));
  });

  it("does not drift with the live EUR/USD rate (the 'wrongly dependent' bug)", () => {
    // Same settled prior FX, but the live rate moves between polls. The dashed
    // line is valued at the *settled* prior FX, so it must not budge — even though
    // the live total value (valued at the live rate) clearly does.
    const slow = buildDashboard(makeExport(), new Map([["VTI", quoteVti], ["SCHB", quoteSchb]]),
      { base: "EUR", rates: { USD: new Decimal("1.10") } }, NOW, null, { fxPrevEurUsd: FX_PREV }).overview;
    const fast = buildDashboard(makeExport(), new Map([["VTI", quoteVti], ["SCHB", quoteSchb]]),
      { base: "EUR", rates: { USD: new Decimal("1.15") } }, NOW, null, { fxPrevEurUsd: FX_PREV }).overview;

    // The live total moved with the rate…
    expect(slow.totalValueEur.toFixed(2)).not.toBe(fast.totalValueEur.toFixed(2));
    // …but the settled prior-close anchor did not.
    expect(slow.prevCloseAnchorEur.toFixed(4)).toBe(fast.prevCloseAnchorEur.toFixed(4));
    expect(slow.prevCloseAnchorUsd!.toFixed(4)).toBe(fast.prevCloseAnchorUsd!.toFixed(4));
  });

  it("is marked provisional only while the settled prior FX is unknown", () => {
    const known = fullyLoaded();
    expect(known.prevCloseProvisional).toBe(false);

    const unknown = buildDashboard(makeExport(), new Map([["VTI", quoteVti], ["SCHB", quoteSchb]]), fxLive, NOW).overview;
    expect(unknown.prevCloseProvisional).toBe(true);
  });
});
