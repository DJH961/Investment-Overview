/**
 * A `null` value in a chart series is a real gap (the feed had no value there),
 * so the line must break into separate sub-paths at the gap rather than bridge
 * across it with a straight segment that invents a value (plan Phase 1 item 6).
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import { linePath } from "../src/chart";

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
});
