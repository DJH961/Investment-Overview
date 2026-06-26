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
import { repairWeekNavCollapse, repairSessionNavCollapse, repairCurrencyDivergence } from "../src/week-repair";

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

describe("repairWeekNavCollapse with a live healthy hint (whole-week collapse, issue #169)", () => {
  it("lifts an *all*-settled collapse onto today's live whole-book level", () => {
    // The entire settled week lost its NAV sleeve (≈60%): no healthy settled day
    // exists, so only today's live value (1000/1100) can anchor the recovery.
    const points = [
      p("2024-06-03T20:00:00Z", 600, 660),
      p("2024-06-04T20:00:00Z", 605, 665),
      p("2024-06-05T20:00:00Z", 610, 670),
    ];
    // Without a hint the bare repair cannot act (the regression that survived).
    expect(repairWeekNavCollapse(points)).toBe(points);
    // With today's healthy level it lifts every settled day by the NAV hole
    // (offset = 1000 − 610 = 390 EUR, 1100 − 670 = 430 USD), de-stepping the run.
    const repaired = repairWeekNavCollapse(points, { eur: d(1000), usd: d(1100) });
    expect(eur(repaired)).toEqual([990, 995, 1000]);
    expect(usd(repaired)).toEqual([1090, 1095, 1100]);
  });

  it("preserves each collapsed day's intraday shape across an all-week lift", () => {
    const points = [
      p("2024-06-03T15:00:00Z", 600, 660),
      p("2024-06-03T20:00:00Z", 620, 680),
      p("2024-06-04T20:00:00Z", 610, 670),
    ];
    const repaired = repairWeekNavCollapse(points, { eur: d(1000), usd: d(1100) });
    // Monday's 20-wide intraday rise survives the constant lift unchanged.
    expect(repaired[1].valueEur.minus(repaired[0].valueEur).toNumber()).toBe(20);
    // The last settled day rises to ≈ today's level (offset = 1000 − 610 = 390).
    expect(repaired[2].valueEur.toNumber()).toBe(1000);
  });

  it("still lifts a single collapsed settled day when only the hint is healthy", () => {
    const points = [
      p("2024-06-04T15:00:00Z", 600, 660),
      p("2024-06-04T20:00:00Z", 610, 670),
    ];
    const repaired = repairWeekNavCollapse(points, { eur: d(1000), usd: d(1100) });
    expect(eur(repaired)).toEqual([990, 1000]);
  });

  it("leaves a healthy week untouched even when a hint is supplied", () => {
    const points = [
      p("2024-06-03T20:00:00Z", 1000, 1100),
      p("2024-06-04T20:00:00Z", 1005, 1105),
      p("2024-06-05T20:00:00Z", 1010, 1110),
    ];
    expect(repairWeekNavCollapse(points, { eur: d(1010), usd: d(1110) })).toBe(points);
  });

  it("does not lift when today's hint is itself collapsed (whole book degraded, not just settled)", () => {
    // Today is as low as the settled days — there is no genuine healthy level to
    // recover to, so nothing is invented (avoids masking a real whole-book drop).
    const points = [
      p("2024-06-03T20:00:00Z", 600, 660),
      p("2024-06-04T20:00:00Z", 605, 665),
    ];
    expect(repairWeekNavCollapse(points, { eur: d(610), usd: d(670) })).toBe(points);
  });
});

describe("repairSessionNavCollapse (the today / single-session case, issue #169)", () => {
  it("lifts a whole intraday session collapsed below its healthy live tip", () => {
    // The whole charted body sits at ~60% (NAV sleeve unvalued in a stale export);
    // only the appended live tip is healthy. The body lifts onto the tip.
    const points = [
      p("2024-06-05T13:30:00Z", 600, 660),
      p("2024-06-05T15:00:00Z", 605, 665),
      p("2024-06-05T17:00:00Z", 610, 670),
      p("2024-06-05T18:00:00Z", 1000, 1100), // live tip — healthy
    ];
    const repaired = repairSessionNavCollapse(points, { eur: d(1000), usd: d(1100) });
    // Offset = tip (1000) − last collapsed (610) = 390 EUR; 1100 − 670 = 430 USD.
    expect(eur(repaired)).toEqual([990, 995, 1000, 1000]);
    expect(usd(repaired)).toEqual([1090, 1095, 1100, 1100]);
  });

  it("preserves the collapsed session's intraday shape (a constant lift)", () => {
    const points = [
      p("2024-06-05T13:30:00Z", 600, 660),
      p("2024-06-05T15:00:00Z", 640, 700),
      p("2024-06-05T18:00:00Z", 1000, 1100),
    ];
    const repaired = repairSessionNavCollapse(points, { eur: d(1000), usd: d(1100) });
    // The 40-wide intraday rise survives the +360 lift unchanged.
    expect(repaired[1].valueEur.minus(repaired[0].valueEur).toNumber()).toBe(40);
    expect(repaired[2].valueEur.toNumber()).toBe(1000);
  });

  it("lifts onto the live-tip hint when *every* charted point collapsed", () => {
    // No healthy charted point at all (the tip was never appended); the hint
    // alone donates the lift.
    const points = [
      p("2024-06-05T13:30:00Z", 600, 660),
      p("2024-06-05T15:00:00Z", 610, 670),
    ];
    const repaired = repairSessionNavCollapse(points, { eur: d(1000), usd: d(1100) });
    expect(eur(repaired)).toEqual([990, 1000]);
    expect(usd(repaired)).toEqual([1090, 1100]);
  });

  it("leaves a healthy session untouched", () => {
    const points = [
      p("2024-06-05T13:30:00Z", 1000, 1100),
      p("2024-06-05T15:00:00Z", 1005, 1105),
      p("2024-06-05T18:00:00Z", 1010, 1110),
    ];
    expect(repairSessionNavCollapse(points, { eur: d(1010), usd: d(1110) })).toBe(points);
  });

  it("does not lift a genuine whole-session drop (the live tip is itself low)", () => {
    // The session really fell and stayed down — the live tip confirms it, so the
    // drop is honest and must not be invented away.
    const points = [
      p("2024-06-05T13:30:00Z", 1000, 1100),
      p("2024-06-05T15:00:00Z", 600, 660),
      p("2024-06-05T18:00:00Z", 605, 665),
    ];
    expect(repairSessionNavCollapse(points, { eur: d(605), usd: d(665) })).toBe(points);
  });

  it("does not lift when the recovery step is too small to be a collapse", () => {
    // The body is ~16% below the tip (flagged low) but the snap-back step is only
    // ~6.5% of the healthy level — under the 8% bar, so read as a soft open.
    const points = [
      p("2024-06-05T13:30:00Z", 840, 900),
      p("2024-06-05T18:00:00Z", 905, 965),
      p("2024-06-05T20:00:00Z", 1000, 1100),
    ];
    expect(repairSessionNavCollapse(points, { eur: d(1000), usd: d(1100) })).toBe(points);
  });

  it("returns short curves unchanged", () => {
    expect(repairSessionNavCollapse([])).toEqual([]);
    const one = [p("2024-06-05T18:00:00Z", 600, 660)];
    expect(repairSessionNavCollapse(one)).toBe(one);
  });
});

describe("repairCurrencyDivergence", () => {
  // EUR/USD ≈ 1.1 across these curves, so a healthy whole-book point has
  // valueUsd ≈ valueEur × 1.1. The defect knocks ONE leg ~40% off that ratio.
  const near = (got: number[], want: number[]): void => {
    expect(got.length).toBe(want.length);
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 4));
  };

  it("heals a USD-only collapse in the body with a healthy snap-back tip (issue #169 screenshot)", () => {
    // EUR healthy throughout; USD tracks at ×1.1 except the body (points 2–3),
    // whose USD nosedives ~37% (NAV sleeve lost) before the live tip snaps back.
    const points = [
      p("2024-06-26T13:30:00Z", 1000, 1100),
      p("2024-06-26T15:00:00Z", 1010, 1111),
      p("2024-06-26T16:30:00Z", 1005, 700),
      p("2024-06-26T18:00:00Z", 1008, 705),
      p("2024-06-26T19:00:00Z", 1009, 1109.9),
    ];
    const repaired = repairCurrencyDivergence(points);
    // EUR is untouched; the corrupt USD body is rebuilt at the prevailing ×1.1.
    near(eur(repaired), [1000, 1010, 1005, 1008, 1009]);
    near(usd(repaired), [1100, 1111, 1105.5, 1108.8, 1109.9]);
  });

  it("heals a USD-only leading run with no healthy neighbour to its left", () => {
    // First two points collapsed in USD (defaults to rebuilding the USD leg),
    // last two healthy at ×1.1.
    const points = [
      p("2024-06-24T20:00:00Z", 1000, 620),
      p("2024-06-25T20:00:00Z", 1010, 626),
      p("2024-06-26T20:00:00Z", 1005, 1105.5),
      p("2024-06-26T20:05:00Z", 1008, 1108.8),
    ];
    const repaired = repairCurrencyDivergence(points);
    near(eur(repaired), [1000, 1010, 1005, 1008]);
    near(usd(repaired), [1100, 1111, 1105.5, 1108.8]);
  });

  it("heals an EUR-only interior dip (rebuilds the EUR leg, not USD)", () => {
    // Point 1's EUR collapses while its USD stays healthy, so the EUR leg is the
    // one that jumps relative to its consistent neighbours.
    const points = [
      p("2024-06-26T13:30:00Z", 1000, 1100),
      p("2024-06-26T15:00:00Z", 600, 1102),
      p("2024-06-26T17:00:00Z", 1005, 1105.5),
      p("2024-06-26T19:00:00Z", 1008, 1108.8),
    ];
    const repaired = repairCurrencyDivergence(points);
    near(usd(repaired), [1100, 1102, 1105.5, 1108.8]);
    // EUR rebuilt from USD at the prevailing ×1.1 (1102 / 1.1 ≈ 1001.8).
    near(eur(repaired), [1000, 1102 / 1.1, 1005, 1008]);
  });

  it("leaves a healthy curve untouched (same array reference)", () => {
    const points = [
      p("2024-06-26T13:30:00Z", 1000, 1100),
      p("2024-06-26T15:00:00Z", 1010, 1111),
      p("2024-06-26T17:00:00Z", 1005, 1105.5),
      p("2024-06-26T19:00:00Z", 1008, 1108.8),
    ];
    expect(repairCurrencyDivergence(points)).toBe(points);
  });

  it("preserves genuine FX divergence within the band (does not flatten the ratio)", () => {
    // EUR flat at 1000 while USD climbs 1.08→1.11 (a ~2.7% FX move) — real, well
    // under the 12% band, so every point stays consistent and untouched.
    const points = [
      p("2024-06-26T13:30:00Z", 1000, 1080),
      p("2024-06-26T15:00:00Z", 1000, 1090),
      p("2024-06-26T17:00:00Z", 1000, 1100),
      p("2024-06-26T19:00:00Z", 1000, 1110),
    ];
    expect(repairCurrencyDivergence(points)).toBe(points);
  });

  it("ignores points with a non-positive leg and short curves", () => {
    expect(repairCurrencyDivergence([])).toEqual([]);
    const two = [p("2024-06-26T13:30:00Z", 1000, 1100), p("2024-06-26T15:00:00Z", 1010, 1111)];
    expect(repairCurrencyDivergence(two)).toBe(two);
    // A zeroed leg is skipped (not treated as a ratio outlier).
    const withZero = [
      p("2024-06-26T13:30:00Z", 1000, 1100),
      p("2024-06-26T15:00:00Z", 0, 0),
      p("2024-06-26T17:00:00Z", 1005, 1105.5),
      p("2024-06-26T19:00:00Z", 1008, 1108.8),
    ];
    expect(repairCurrencyDivergence(withZero)).toBe(withZero);
  });
});
