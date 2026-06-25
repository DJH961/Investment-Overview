/**
 * The collapsed-session "1W" x-axis: dead time between sessions (nights,
 * weekends, holidays) is dropped by packing each trading day into an equal-width
 * band. The bands sit directly adjacent (no gutter), the curve connects across
 * them as one continuous line, a separator rule marks each day boundary, and
 * each band is labelled by weekday + day-of-month.
 */
import { describe, expect, it } from "vitest";

import { sessionFractions } from "../src/chart";

/** Build a run of `count` ISO instants `stepMin` minutes apart from `start`. */
function instants(start: string, count: number, stepMin: number): string[] {
  const base = new Date(start).getTime();
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(new Date(base + i * stepMin * 60_000).toISOString());
  return out;
}

describe("sessionFractions", () => {
  it("packs each calendar day into an equal-width, directly-adjacent band", () => {
    // Two sessions a full calendar day apart, each ~6.5h of intraday points. On a
    // wall-clock axis the overnight gap would eat most of the width; collapsed,
    // the two bands are equal and adjacent (no gutter between them).
    const dayA = instants("2026-06-22T13:30:00Z", 7, 65); // ~6.5h
    const dayB = instants("2026-06-23T13:30:00Z", 7, 65);
    const layout = sessionFractions([...dayA, ...dayB])!;
    expect(layout).not.toBeNull();
    expect(layout.bands.map((b) => b.day)).toEqual(["2026-06-22", "2026-06-23"]);

    const bandWidth = 1 / 2;
    // Band A spans [0, bandWidth]; band B spans [bandWidth, 1] — touching, so the
    // close of A and the open of B share the boundary x (a direct connection).
    expect(layout.fractions[0]).toBeCloseTo(0, 6);
    expect(layout.fractions[6]).toBeCloseTo(bandWidth, 6);
    expect(layout.fractions[7]).toBeCloseTo(bandWidth, 6);
    expect(layout.fractions[13]).toBeCloseTo(1, 6);
  });

  it("places one separator per day boundary, on the boundary itself", () => {
    const dayA = instants("2026-06-22T13:30:00Z", 3, 120);
    const dayB = instants("2026-06-23T13:30:00Z", 3, 120);
    const dayC = instants("2026-06-24T13:30:00Z", 3, 120);
    const layout = sessionFractions([...dayA, ...dayB, ...dayC])!;
    expect(layout.separators).toHaveLength(2);
    const bandWidth = 1 / 3;
    expect(layout.separators[0]).toBeCloseTo(bandWidth, 6);
    expect(layout.separators[1]).toBeCloseTo(2 * bandWidth, 6);
    // Separators are strictly inside the plot and ascending.
    for (const s of layout.separators) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
  });

  it("places points within a band by their own session's elapsed fraction", () => {
    // A day whose points are NOT evenly spaced: a dense cluster late in the day
    // must sit late in the band, not be spread across it by point count.
    const dates = [
      "2026-06-22T13:30:00Z",
      "2026-06-22T19:00:00Z",
      "2026-06-22T19:30:00Z",
      "2026-06-22T20:00:00Z",
    ];
    const layout = sessionFractions(dates)!;
    expect(layout.bands).toHaveLength(1);
    // Single band fills the full width. Open at 0, close at 1.
    expect(layout.fractions[0]).toBeCloseTo(0, 6);
    expect(layout.fractions[3]).toBeCloseTo(1, 6);
    // The 19:00 point is ~85% through the 13:30->20:00 span, so it sits far right.
    expect(layout.fractions[1]).toBeGreaterThan(0.8);
  });

  it("centres a lone close-only day in its band", () => {
    const layout = sessionFractions([
      "2026-06-22T00:00:00Z", // coarse close A
      "2026-06-23T00:00:00Z", // coarse close B
    ])!;
    const bandWidth = 1 / 2;
    expect(layout.fractions[0]).toBeCloseTo(bandWidth / 2, 6);
    expect(layout.fractions[1]).toBeCloseTo(bandWidth + bandWidth / 2, 6);
  });

  it("returns null for too few points or non-date labels", () => {
    expect(sessionFractions([])).toBeNull();
    expect(sessionFractions(["2026-06-22T00:00:00Z"])).toBeNull();
    expect(sessionFractions(["not-a-date", "also-not"])).toBeNull();
  });
});
