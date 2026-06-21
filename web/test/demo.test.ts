/**
 * Demo / preview mode builds a complete, sensible dashboard from the baked-in
 * sample data — no network, no key, no passphrase. This guards the preview path
 * that the setup screen and the `?demo` URL expose.
 */
import { describe, expect, it } from "vitest";

import { buildDemoModel } from "../src/demo";

describe("buildDemoModel", () => {
  const model = buildDemoModel();

  it("produces a positive total value across several holdings", () => {
    expect(model.holdings.length).toBeGreaterThanOrEqual(5);
    expect(model.overview.totalValueEur.greaterThan(0)).toBe(true);
    expect(model.overview.holdingsCount).toBe(model.holdings.length);
  });

  it("computes a portfolio XIRR from the sample cashflows", () => {
    expect(model.overview.portfolioXirr).not.toBeNull();
  });

  it("flags the NAV holding as a non-live (fallback) price", () => {
    const navRow = model.holdings.find((holding) => holding.priceType === "nav");
    expect(navRow).toBeDefined();
    expect(navRow?.priceIsLive).toBe(false);
  });

  it("has no missing FX legs (USD rate is provided)", () => {
    expect(model.overview.fxMissingCurrencies).toEqual([]);
  });

  it("includes a cash balance in the total", () => {
    expect(model.overview.cashValueEur.greaterThan(0)).toBe(true);
  });

  it("builds the Phase 4 periods, analytics, deposits and plan blocks", () => {
    expect(model.periods.monthly.length).toBeGreaterThan(0);
    expect(model.periods.yearly.length).toBeGreaterThan(0);
    // The newest month/year is overlaid with the live recompute.
    expect(model.periods.monthly[0].isCurrent).toBe(true);
    expect(model.analytics).not.toBeNull();
    expect(model.deposits).not.toBeNull();
    expect(model.plan.startingValueEur.greaterThan(0)).toBe(true);
    expect(model.plan.defaultAnnualContributionEur.greaterThan(0)).toBe(true);
  });
});
