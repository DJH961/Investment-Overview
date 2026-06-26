/**
 * The headline percentage beside the value chart must read the same rise/fall the
 * live line draws — identical to the pixel — for both the 1D and 1W curves, and in
 * whichever currency the curve is denominated. {@link liveCurveToChart} therefore
 * reports the curve's own `growthPct`: the 1D curve measures from its dashed
 * previous-close reference (what "% today" is anchored to), the 1W curve from its
 * first plotted point. {@link curveGrowthPct} is the underlying helper.
 */
import Decimal from "decimal.js";
import { afterEach, describe, expect, it } from "vitest";

import { setDisplayCurrency, setEurUsdRate } from "../src/currency";
import type { CurvePoint } from "../src/timeseries";
import { curveGrowthPct, liveCurveToChart } from "../src/ui";

/** A two-point intraday curve (instants on one calendar day). */
function intradayPoints(): CurvePoint[] {
  const base = new Date("2026-06-19T13:30:00Z").getTime();
  return [
    { t: base, valueEur: new Decimal("50000"), valueUsd: new Decimal("54000") },
    { t: base + 30 * 60_000, valueEur: new Decimal("50200"), valueUsd: new Decimal("54200") },
  ];
}

/** A multi-session daily curve (one close per day). */
function weekPoints(): CurvePoint[] {
  const day = 24 * 60 * 60_000;
  const base = new Date("2026-06-15T20:00:00Z").getTime();
  return [
    { t: base, valueEur: new Decimal("48000"), valueUsd: new Decimal("52000") },
    { t: base + day, valueEur: new Decimal("48500"), valueUsd: new Decimal("52400") },
    { t: base + 2 * day, valueEur: new Decimal("49200"), valueUsd: new Decimal("53100") },
  ];
}

const prevClose = { eur: new Decimal("49800"), usd: new Decimal("53800") };

afterEach(() => {
  setDisplayCurrency("EUR");
  setEurUsdRate(null);
});

describe("curveGrowthPct", () => {
  it("measures from an explicit base (the 1D previous close) to the tip", () => {
    // (50200 − 49800) / 49800
    const pct = curveGrowthPct([new Decimal("50000"), new Decimal("50200")], new Decimal("49800"));
    expect(pct!.toNumber()).toBeCloseTo(400 / 49800, 12);
  });

  it("falls back to the first plotted point when no base is given (the 1W curve)", () => {
    // (49200 − 48000) / 48000
    const pct = curveGrowthPct([new Decimal("48000"), new Decimal("49200")]);
    expect(pct!.toNumber()).toBeCloseTo(1200 / 48000, 12);
  });

  it("ignores null gaps, anchoring on the first and last real points", () => {
    const pct = curveGrowthPct([null, new Decimal("100"), null, new Decimal("110"), null]);
    expect(pct!.toNumber()).toBeCloseTo(0.1, 12);
  });

  it("returns null when the base is non-positive or there is no tip", () => {
    expect(curveGrowthPct([new Decimal("0"), new Decimal("5")])).toBeNull();
    expect(curveGrowthPct([null, null])).toBeNull();
  });
});

describe("liveCurveToChart growthPct (identical to the pixel)", () => {
  it("1D: reports growth from the previous-close reference to the tip", () => {
    setDisplayCurrency("EUR");
    const chart = liveCurveToChart(intradayPoints(), prevClose);
    // Anchored on the EUR previous close (49800), not the curve's first point.
    expect(chart!.growthPct!.toNumber()).toBeCloseTo(400 / 49800, 12);
  });

  it("1D: stays currency-aware, measuring the USD line off the USD close", () => {
    setDisplayCurrency("USD");
    setEurUsdRate(new Decimal("1.08"));
    const chart = liveCurveToChart(intradayPoints(), prevClose);
    // (54200 − 53800) / 53800, on the FX-free USD line.
    expect(chart!.growthPct!.toNumber()).toBeCloseTo(400 / 53800, 12);
  });

  it("1W: reports growth from the first session to the tip (no reference line)", () => {
    setDisplayCurrency("EUR");
    const chart = liveCurveToChart(weekPoints(), null);
    expect(chart!.referenceLine).toBeUndefined();
    expect(chart!.growthPct!.toNumber()).toBeCloseTo(1200 / 48000, 12);
  });

  it("1W: stays currency-aware, measuring the USD line off the USD start", () => {
    setDisplayCurrency("USD");
    setEurUsdRate(new Decimal("1.08"));
    const chart = liveCurveToChart(weekPoints(), null);
    expect(chart!.growthPct!.toNumber()).toBeCloseTo(1100 / 52000, 12);
  });
});
