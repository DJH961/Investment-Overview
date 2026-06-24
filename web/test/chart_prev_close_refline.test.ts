/**
 * The live 1D curve marks the previous session's settled close as a neutral
 * dashed reference line (mirroring the desktop "1 Day" chart), so the user can
 * see whether the live value sits above or below where the portfolio last
 * *closed*. The reference is denominated in the active display currency and only
 * appears when that currency's previous-close figure is known.
 */
import Decimal from "decimal.js";
import { afterEach, describe, expect, it } from "vitest";

import { setDisplayCurrency, setEurUsdRate } from "../src/currency";
import type { CurvePoint } from "../src/timeseries";
import { liveCurveToChart } from "../src/ui";

/** A two-point intraday curve (instants on one calendar day). */
function intradayPoints(): CurvePoint[] {
  const base = new Date("2026-06-19T13:30:00Z").getTime();
  return [
    { t: base, valueEur: new Decimal("50000"), valueUsd: new Decimal("54000") },
    { t: base + 30 * 60_000, valueEur: new Decimal("50200"), valueUsd: new Decimal("54200") },
  ];
}

const prevClose = { eur: new Decimal("49800"), usd: new Decimal("53800") };

afterEach(() => {
  setDisplayCurrency("EUR");
  setEurUsdRate(null);
});

describe("liveCurveToChart previous-close reference line", () => {
  it("marks the EUR previous close when EUR is the display currency", () => {
    setDisplayCurrency("EUR");
    const chart = liveCurveToChart(intradayPoints(), prevClose);
    expect(chart).not.toBeNull();
    expect(chart!.referenceLine).toBeDefined();
    expect(chart!.referenceLine!.value.toNumber()).toBe(49800);
    expect(chart!.referenceLine!.label).toMatch(/^Prev close €/);
  });

  it("marks the USD previous close when USD is shown and FX is known", () => {
    setDisplayCurrency("USD");
    setEurUsdRate(new Decimal("1.08"));
    const chart = liveCurveToChart(intradayPoints(), prevClose);
    expect(chart).not.toBeNull();
    expect(chart!.referenceLine).toBeDefined();
    // The USD figure is used verbatim (FX-free), not a rescale of the EUR close.
    expect(chart!.referenceLine!.value.toNumber()).toBe(53800);
    expect(chart!.referenceLine!.label).toMatch(/^Prev close \$/);
  });

  it("draws no reference line when no previous close is supplied (e.g. 1W)", () => {
    setDisplayCurrency("EUR");
    expect(liveCurveToChart(intradayPoints(), null)!.referenceLine).toBeUndefined();
    expect(liveCurveToChart(intradayPoints())!.referenceLine).toBeUndefined();
  });

  it("draws no reference line when the active currency's close is unknown", () => {
    setDisplayCurrency("EUR");
    const chart = liveCurveToChart(intradayPoints(), { eur: null, usd: new Decimal("53800") });
    expect(chart!.referenceLine).toBeUndefined();
  });
});
