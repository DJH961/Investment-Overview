/**
 * A `null` value in a chart series is a real gap (the feed had no value there),
 * so the line must break into separate sub-paths at the gap rather than bridge
 * across it with a straight segment that invents a value (plan Phase 1 item 6).
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import { linePath, areaPathD } from "../src/chart";

const x = (i: number): number => i;
const y = (v: number): number => v;
const d = (n: number): Decimal => new Decimal(n);

describe("linePath gap handling", () => {
  it("draws one continuous sub-path when there are no gaps", () => {
    const path = linePath([d(1), d(2), d(3)], x, y);
    // Exactly one move-to, the rest line-to: a single connected segment.
    expect((path.match(/M/g) ?? []).length).toBe(1);
    expect(path.startsWith("M")).toBe(true);
    expect((path.match(/L/g) ?? []).length).toBe(2);
  });

  it("breaks the line into separate sub-paths across an interior gap", () => {
    const path = linePath([d(1), d(2), null, d(4), d(5)], x, y);
    // Two runs ⇒ two move-tos; the gap is NOT bridged by an `L`.
    expect((path.match(/M/g) ?? []).length).toBe(2);
    // The point after the gap starts a fresh sub-path, never an `L` from before.
    expect(path).toContain("M3.0 4.0");
  });

  it("starts a sub-path only at the first real value after leading gaps", () => {
    const path = linePath([null, null, d(3)], x, y);
    expect(path).toBe("M2.0 3.0");
  });

  it("returns an empty string when every value is a gap", () => {
    expect(linePath([null, null], x, y)).toBe("");
  });

  it("breaks the line into separate sub-paths across a day boundary when dates are provided", () => {
    const path = linePath(
      [d(1), d(2), d(3), d(4)],
      x,
      y,
      ["2026-07-01T09:30:00Z", "2026-07-01T16:00:00Z", "2026-07-02T09:30:00Z", "2026-07-02T16:00:00Z"]
    );
    // Two days ⇒ two move-tos; the day change is NOT bridged by an `L`.
    expect((path.match(/M/g) ?? []).length).toBe(2);
    expect(path).toContain("M2.0 3.0");
  });

  it("builds correct closed polygons for area paths with day boundaries", () => {
    const path = areaPathD(
      [d(1), d(2), d(3), d(4)],
      x,
      y,
      100,
      ["2026-07-01T09:30:00Z", "2026-07-01T16:00:00Z", "2026-07-02T09:30:00Z", "2026-07-02T16:00:00Z"]
    );
    // Two days => two closed paths ending with Z.
    expect((path.match(/Z/g) ?? []).length).toBe(2);
    // The first sub-path ends at x=1 and closes back to baseline (y=100) at x=1 and x=0
    expect(path).toContain("M0.0 1.0 L1.0 2.0 L1.0 100.0 L0.0 100.0 Z");
    // The second sub-path starts at x=2 and closes back to baseline (y=100) at x=3 and x=2
    expect(path).toContain("M2.0 3.0 L3.0 4.0 L3.0 100.0 L2.0 100.0 Z");
  });
});
