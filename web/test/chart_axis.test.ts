/**
 * The x-axis tick set adapts to the displayed window: short ranges (a quarter
 * or less, e.g. the "1M" view) are labelled by day-of-month, wider ranges keep
 * the compact month label. Several roughly-even ticks are returned so the axis
 * reads clearly.
 */
import { describe, expect, it } from "vitest";

import { intradayTimeTicks, xAxisTicks } from "../src/chart";

/** Build a run of consecutive ISO dates starting at `start`. */
function days(start: string, count: number): string[] {
  const out: string[] = [];
  const base = new Date(`${start}T00:00:00Z`).getTime();
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

describe("xAxisTicks", () => {
  it("labels a one-month window by day-of-month, not the month name", () => {
    const ticks = xAxisTicks(days("2026-05-20", 31));
    // Day labels look like "20 May", never "May '26".
    for (const t of ticks) {
      expect(t.text).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    }
    expect(ticks[0]!.text).toBe("20 May");
    expect(ticks[ticks.length - 1]!.text).toBe("19 Jun");
  });

  it("keeps a compact month label for a wide (multi-year) window", () => {
    const ticks = xAxisTicks(days("2024-01-01", 500));
    for (const t of ticks) {
      expect(t.text).toMatch(/^[A-Z][a-z]{2} '\d{2}$/);
    }
  });

  it("returns more than the old three ticks when space allows, anchored at the ends", () => {
    const ticks = xAxisTicks(days("2026-05-20", 31));
    expect(ticks.length).toBeGreaterThan(3);
    expect(ticks[0]!.index).toBe(0);
    expect(ticks[0]!.anchor).toBe("start");
    expect(ticks[ticks.length - 1]!.index).toBe(30);
    expect(ticks[ticks.length - 1]!.anchor).toBe("end");
    // Interior ticks are centred under their position.
    expect(ticks[1]!.anchor).toBe("middle");
  });

  it("never produces duplicate indexes for a very short series", () => {
    const ticks = xAxisTicks(days("2026-06-01", 2));
    const indexes = ticks.map((t) => t.index);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(indexes).toEqual([0, 1]);
  });

  it("labels an intraday (single-day) window by time-of-day, not a repeated date", () => {
    // The live "1D" curve passes full ISO instants that all fall on one calendar
    // day; a date axis would just repeat that date, so we want clock times.
    const base = new Date("2026-06-19T13:30:00Z").getTime();
    const intraday: string[] = [];
    for (let i = 0; i < 8; i += 1) intraday.push(new Date(base + i * 30 * 60_000).toISOString());
    const ticks = xAxisTicks(intraday);
    // No tick should look like a date label ("19 Jun" / "Jun '26").
    for (const t of ticks) {
      expect(t.text).not.toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
      expect(t.text).not.toMatch(/^[A-Z][a-z]{2} '\d{2}$/);
      // It should read as a clock time (contains a ":" between digits).
      expect(t.text).toMatch(/\d:\d{2}/);
    }
    // Ends are still anchored.
    expect(ticks[0]!.anchor).toBe("start");
    expect(ticks[ticks.length - 1]!.anchor).toBe("end");
  });

  it("scales a multi-day (1W-style) timeline by elapsed time too, not point index", () => {
    // The live "1W" curve is daily closes, but the final day can carry many more
    // blob-backed points. Those extra points must not balloon the last day across
    // the plot — placement is by elapsed time, identical to the 1D fix.
    const dates: string[] = [];
    const start = new Date("2026-06-15T20:00:00Z").getTime();
    // One close per day for five days …
    for (let d = 0; d < 5; d += 1) dates.push(new Date(start + d * 86_400_000).toISOString());
    // … then a dense burst of points within the final day.
    const denseDay = start + 5 * 86_400_000;
    for (let i = 1; i <= 30; i += 1) dates.push(new Date(denseDay + i * 60_000).toISOString());

    const first = Date.parse(dates[0]);
    const span = Date.parse(dates[dates.length - 1]) - first;
    const positions = dates.map((d) => (Date.parse(d) - first) / span);

    // The dense tail spans ~30 min out of ~6 days, so every dense point must sit
    // in the far-right sliver of the axis — never spread across it by count.
    const denseFracs = positions.slice(5);
    for (const f of denseFracs) expect(f).toBeGreaterThan(0.82);

    const ticks = xAxisTicks(dates, 5, positions);
    const fracs = ticks.map((t) => positions[t.index]);
    expect(fracs[0]).toBeCloseTo(0, 2);
    expect(fracs[fracs.length - 1]).toBeCloseTo(1, 2);
    const mid = fracs[Math.floor(fracs.length / 2)]!;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });

  it("spaces ticks by elapsed time, not point index, when positions are supplied", () => {
    // A timeline where the final hour carries many more samples than the rest of
    // the day (the blob-backed "extra data in the final hour" case). Index-based
    // ticks would bunch under that dense tail; fraction-based ticks stay even.
    const dates: string[] = [];
    const start = new Date("2026-06-19T13:30:00Z").getTime();
    // Sparse points across ~6h (every 30 min), then a dense burst in the last hour.
    for (let i = 0; i < 12; i += 1) dates.push(new Date(start + i * 30 * 60_000).toISOString());
    const denseStart = start + 6 * 3_600_000;
    for (let i = 1; i <= 40; i += 1) dates.push(new Date(denseStart + i * 60_000).toISOString());

    const first = Date.parse(dates[0]);
    const span = Date.parse(dates[dates.length - 1]) - first;
    const positions = dates.map((d) => (Date.parse(d) - first) / span);

    const ticks = xAxisTicks(dates, 5, positions);
    // Interior ticks should sit at roughly-even fractions across the axis, so the
    // selected indexes are NOT clustered at the dense tail.
    const fracs = ticks.map((t) => positions[t.index]);
    expect(fracs[0]).toBeCloseTo(0, 2);
    expect(fracs[fracs.length - 1]).toBeCloseTo(1, 2);
    // The mid tick should be near the middle of elapsed time, not near the end
    // where most of the points live.
    const mid = fracs[Math.floor(fracs.length / 2)]!;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });
});

describe("intradayTimeTicks", () => {
  /** Build `count` ISO instants `stepMin` minutes apart from `start`. */
  function instants(start: string, count: number, stepMin: number): string[] {
    const base = new Date(start).getTime();
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) out.push(new Date(base + i * stepMin * 60_000).toISOString());
    return out;
  }

  it("returns regular, clock-aligned ticks positioned by elapsed fraction", () => {
    // A full ~6.5h session sampled every 30 min (14 points).
    const ticks = intradayTimeTicks(instants("2026-06-22T13:30:00Z", 14, 30))!;
    expect(ticks).not.toBeNull();
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    // Every tick reads as a clock time, never a date.
    for (const t of ticks) {
      expect(t.text).toMatch(/\d:\d{2}/);
      expect(t.text).not.toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    }
    // Fractions are within range and strictly ascending (regular spacing).
    for (const t of ticks) {
      expect(t.frac).toBeGreaterThanOrEqual(0);
      expect(t.frac).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i].frac).toBeGreaterThan(ticks[i - 1].frac);
    }
  });

  it("ticks land on round clock boundaries regardless of where data starts", () => {
    // Mid-session login: the first sample is at an odd minute, but the ticks must
    // still snap to round clock instants (e.g. on the hour / half hour).
    const ticks = intradayTimeTicks(instants("2026-06-22T13:47:00Z", 10, 14))!;
    const minutes = ticks.map((t) => {
      const m = /:(\d{2})/.exec(t.text);
      return m ? Number(m[1]) : NaN;
    });
    // The chosen step divides the hour evenly, so every tick minute is a multiple
    // of the step — never the raw 13:47 start offset.
    const stepMin = minutes.length >= 2 ? ((minutes[1] - minutes[0]) % 60 + 60) % 60 : 0;
    expect(stepMin).toBeGreaterThan(0);
    for (const min of minutes) expect(min % stepMin).toBe(0);
  });

  it("adapts the step to a short window so it stays well populated", () => {
    // A ~40-minute window must not collapse to a single tick — it should pick a
    // finer step and still place several regular ticks.
    const ticks = intradayTimeTicks(instants("2026-06-22T13:30:00Z", 9, 5))!;
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back (null) for non-intraday or degenerate windows", () => {
    // Plain calendar dates carry no clock time.
    expect(intradayTimeTicks(["2026-06-20", "2026-06-21"])).toBeNull();
    // A single point is not a window.
    expect(intradayTimeTicks(["2026-06-22T13:30:00Z"])).toBeNull();
    // A multi-day span is not intraday.
    expect(
      intradayTimeTicks(["2026-06-20T13:30:00Z", "2026-06-23T13:30:00Z"]),
    ).toBeNull();
  });
});