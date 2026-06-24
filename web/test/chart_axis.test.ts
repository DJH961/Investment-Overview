/**
 * The x-axis tick set adapts to the displayed window: short ranges (a quarter
 * or less, e.g. the "1M" view) are labelled by day-of-month, wider ranges keep
 * the compact month label. Several roughly-even ticks are returned so the axis
 * reads clearly.
 */
import { describe, expect, it } from "vitest";

import { xAxisTicks } from "../src/chart";

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