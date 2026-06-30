/**
 * The live render funnel (`liveCurveToChart`) heals a both-currency NAV-collapse
 * confined to **today** (the trailing session) before drawing — the 1W reload
 * nosedive that the leading-run NAV repairs (springboard-only) and the
 * single-currency `repairCurrencyDivergence` both structurally miss. A healthy
 * curve is drawn verbatim.
 */
import Decimal from "decimal.js";
import { afterEach, describe, expect, it } from "vitest";

import { setDisplayCurrency, setEurUsdRate } from "../src/currency";
import type { CurvePoint } from "../src/timeseries";
import { liveCurveToChart } from "../src/ui";

const d = (v: number): Decimal => new Decimal(v);
function p(t: string, eur: number, usd: number): CurvePoint {
  return { t: new Date(t).getTime(), valueEur: d(eur), valueUsd: d(usd) };
}

// Mon/Tue settled healthy at ~46k; today (Wed) is valued without its NAV sleeve
// (~28k) until the dense bars load, then the live tip snaps back — the exact
// shape of the reported 1W reload nosedive.
function collapsedWeek(): CurvePoint[] {
  return [
    p("2024-06-03T20:00:00Z", 46000, 50600),
    p("2024-06-04T20:00:00Z", 46100, 50710),
    p("2024-06-05T14:00:00Z", 28000, 30800),
    p("2024-06-05T15:00:00Z", 28100, 30910),
    p("2024-06-05T16:00:00Z", 28050, 30855),
    p("2024-06-05T20:00:00Z", 46050, 50655),
  ];
}

afterEach(() => {
  setDisplayCurrency("EUR");
  setEurUsdRate(null);
});

describe("liveCurveToChart today NAV-collapse safety net", () => {
  it("lifts today's collapsed body onto the live tip (EUR view)", () => {
    const chart = liveCurveToChart(collapsedWeek(), null);
    expect(chart).not.toBeNull();
    const eur = chart!.series[0].values.map((v) => (v ? v.toNumber() : null));
    // No drawn point nosedives below the healthy week level any more.
    for (const v of eur) expect(v).toBeGreaterThan(45000);
  });

  it("lifts today's collapsed body in the USD view too", () => {
    setEurUsdRate(new Decimal("1.1"));
    setDisplayCurrency("USD");
    const chart = liveCurveToChart(collapsedWeek(), null);
    const usd = chart!.series[0].values.map((v) => (v ? v.toNumber() : null));
    for (const v of usd) expect(v).toBeGreaterThan(49000);
  });

  it("draws a healthy week verbatim (no spurious lift)", () => {
    const healthy: CurvePoint[] = [
      p("2024-06-03T20:00:00Z", 46000, 50600),
      p("2024-06-04T20:00:00Z", 46100, 50710),
      p("2024-06-05T14:00:00Z", 45800, 50380),
      p("2024-06-05T20:00:00Z", 46080, 50688),
    ];
    const chart = liveCurveToChart(healthy, null);
    const eur = chart!.series[0].values.map((v) => (v ? v.toNumber() : null));
    expect(eur).toEqual([46000, 46100, 45800, 46080]);
  });
});
