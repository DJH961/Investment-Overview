/**
 * The live 1D curve surfaces an honest coverage caption when it was reconstructed
 * from fewer than all of the sleeve's holdings — the rest are carried flat for
 * want of bars, so the line understates the day's true shape (scenario C). A
 * fully-covered curve (or one with no coverage info, e.g. the exported springboard
 * or the 1W curve) stays quiet.
 */
import Decimal from "decimal.js";
import { afterEach, describe, expect, it } from "vitest";

import { setDisplayCurrency, setEurUsdRate } from "../src/currency";
import type { CurvePoint } from "../src/timeseries";
import { liveCurveToChart } from "../src/ui";

function intradayPoints(): CurvePoint[] {
  const base = new Date("2026-06-19T13:30:00Z").getTime();
  return [
    { t: base, valueEur: new Decimal("50000"), valueUsd: new Decimal("54000") },
    { t: base + 30 * 60_000, valueEur: new Decimal("50200"), valueUsd: new Decimal("54200") },
  ];
}

afterEach(() => {
  setDisplayCurrency("EUR");
  setEurUsdRate(null);
});

describe("liveCurveToChart coverage caption", () => {
  it("captions a partial-sleeve curve with the covered/total counts", () => {
    const chart = liveCurveToChart(intradayPoints(), null, { covered: 6, total: 10 });
    expect(chart).not.toBeNull();
    expect(chart!.note).toBeDefined();
    expect(chart!.note).toMatch(/6 of 10 holdings/);
  });

  it("stays quiet when every sleeve holding has bars", () => {
    const chart = liveCurveToChart(intradayPoints(), null, { covered: 10, total: 10 });
    expect(chart!.note).toBeUndefined();
  });

  it("stays quiet when there is no sleeve to cover", () => {
    const chart = liveCurveToChart(intradayPoints(), null, { covered: 0, total: 0 });
    expect(chart!.note).toBeUndefined();
  });

  it("stays quiet when no coverage info is supplied (springboard / 1W)", () => {
    expect(liveCurveToChart(intradayPoints(), null)!.note).toBeUndefined();
    expect(liveCurveToChart(intradayPoints())!.note).toBeUndefined();
  });
});

describe("liveCurveToChart coverage passthrough", () => {
  it("echoes a partial-sleeve coverage so the wrapper can hold the old graph", () => {
    const chart = liveCurveToChart(intradayPoints(), null, { covered: 6, total: 10 });
    expect(chart!.coverage).toEqual({ covered: 6, total: 10 });
  });

  it("reports complete coverage when every holding has bars", () => {
    const chart = liveCurveToChart(intradayPoints(), null, { covered: 10, total: 10 });
    expect(chart!.coverage).toEqual({ covered: 10, total: 10 });
  });

  it("omits coverage entirely when there is no sleeve (treated as complete)", () => {
    expect(liveCurveToChart(intradayPoints(), null, { covered: 0, total: 0 })!.coverage).toBeUndefined();
    expect(liveCurveToChart(intradayPoints(), null)!.coverage).toBeUndefined();
    expect(liveCurveToChart(intradayPoints())!.coverage).toBeUndefined();
  });
});
