/**
 * Tests for the 1W "NAV-collapse nosedive" self-heal (`week-repair.ts`): a
 * collapsed leading run of session days (the desktop bug from issue #169, baked
 * into a stale blob) is lifted back onto the week's healthy level, while a normal
 * week — flat, trending, or merely volatile — is returned untouched.
 *
 * Pure: points are constructed inline, no DOM / network / clock. Daily closes are
 * stamped at 16:00 ET = 20:00Z so each lands on its own UTC session day.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { CurvePoint } from "../src/timeseries";
import { repairWeekNavCollapse } from "../src/week-repair";

const d = (v: string | number): Decimal => new Decimal(v);

function p(t: string, eur: number, usd: number): CurvePoint {
  return { t: Date.parse(t), valueEur: d(eur), valueUsd: d(usd) };
}

const eur = (points: CurvePoint[]): number[] => points.map((q) => q.valueEur.toNumber());
const usd = (points: CurvePoint[]): number[] => points.map((q) => q.valueUsd.toNumber());

describe("repairWeekNavCollapse", () => {
  it("lifts a collapsed leading day back onto the healthy level (issue #169)", () => {
    // Mon collapsed to ~62% (NAV sleeve unvalued), Tue/Wed healthy at ~1000.
    const points = [
      p("2024-06-03T19:55:00Z", 600, 660),
      p("2024-06-03T20:00:00Z", 620, 680),
      p("2024-06-04T20:00:00Z", 1000, 1100),
      p("2024-06-05T20:00:00Z", 1010, 1110),
    ];
    const repaired = repairWeekNavCollapse(points);
    // Offset = Tue open (1000) − Mon close (620) = 380 (EUR); 1100 − 680 = 420 (USD).
    expect(eur(repaired)).toEqual([980, 1000, 1000, 1010]);
    expect(usd(repaired)).toEqual([1080, 1100, 1100, 1110]);
  });

  it("preserves the collapsed day's own intraday shape (a constant lift)", () => {
    const points = [
      p("2024-06-03T15:00:00Z", 600, 660),
      p("2024-06-03T20:00:00Z", 640, 700),
      p("2024-06-04T20:00:00Z", 1000, 1100),
      p("2024-06-05T20:00:00Z", 990, 1090),
    ];
    const repaired = repairWeekNavCollapse(points);
    // The 40-wide intraday rise on Monday survives the +360 lift unchanged.
    expect(repaired[1].valueEur.minus(repaired[0].valueEur).toNumber()).toBe(40);
  });

  it("repairs a multi-day leading collapse with one constant offset", () => {
    const points = [
      p("2024-06-03T20:00:00Z", 620, 680),
      p("2024-06-04T20:00:00Z", 640, 700),
      p("2024-06-05T20:00:00Z", 1010, 1110),
    ];
    const repaired = repairWeekNavCollapse(points);
    // Both collapsed days lift by the boundary step (1010 − 640 = 370); their
    // genuine day-to-day move (620→640) is preserved.
    expect(eur(repaired)).toEqual([990, 1010, 1010]);
  });

  it("leaves a flat healthy week untouched", () => {
    const points = [
      p("2024-06-03T20:00:00Z", 1000, 1100),
      p("2024-06-04T20:00:00Z", 1005, 1105),
      p("2024-06-05T20:00:00Z", 1010, 1110),
    ];
    expect(repairWeekNavCollapse(points)).toBe(points);
  });

  it("leaves a genuine steady uptrend untouched", () => {
    // Rises ~9% across the week — below the 15% collapse floor, so not flagged.
    const points = [
      p("2024-06-03T20:00:00Z", 1000, 1100),
      p("2024-06-04T20:00:00Z", 1050, 1150),
      p("2024-06-05T20:00:00Z", 1090, 1190),
    ];
    expect(repairWeekNavCollapse(points)).toBe(points);
  });

  it("leaves ordinary mid-week volatility untouched (depression must lead and stay recovered)", () => {
    // A low Wednesday in the middle is not a *leading* collapse, and the week
    // does not stay recovered after it, so nothing is lifted.
    const points = [
      p("2024-06-03T20:00:00Z", 1000, 1100),
      p("2024-06-04T20:00:00Z", 620, 680),
      p("2024-06-05T20:00:00Z", 1010, 1110),
    ];
    expect(repairWeekNavCollapse(points)).toBe(points);
  });

  it("does not lift when the recovery step is too small to be a collapse", () => {
    // Monday is ~16% below the week's high (flagged as low) but the boundary step
    // up to the next healthy day (905 − 840 = 65 ≈ 6.5% of 1000) is under the 8%
    // bar, so it reads as a soft start, not a NAV snap-back — left untouched.
    const points = [
      p("2024-06-03T20:00:00Z", 840, 900),
      p("2024-06-04T20:00:00Z", 905, 965),
      p("2024-06-05T20:00:00Z", 1000, 1100),
    ];
    expect(repairWeekNavCollapse(points)).toBe(points);
  });

  it("returns short curves unchanged", () => {
    expect(repairWeekNavCollapse([])).toEqual([]);
    const one = [p("2024-06-05T20:00:00Z", 600, 660)];
    expect(repairWeekNavCollapse(one)).toBe(one);
    // Two points on the same day are a single group — nothing to compare against.
    const sameDay = [p("2024-06-05T15:00:00Z", 600, 660), p("2024-06-05T20:00:00Z", 1000, 1100)];
    expect(repairWeekNavCollapse(sameDay)).toBe(sameDay);
  });
});
