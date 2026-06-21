/**
 * The equity-curve benchmark overlay must be rebased to the portfolio's scale.
 *
 * The export carries `benchmark_value` as the benchmark's raw closing level
 * (e.g. an index at ~120), orders of magnitude below the portfolio value, so
 * plotted as-is the comparison line is pinned flat to the floor. {@link
 * rebaseBenchmark} anchors it to the first non-zero portfolio value so the two
 * lines start together and the benchmark actually rises.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { rebaseBenchmark } from "../src/ui";

type Curve = Parameters<typeof rebaseBenchmark>[0];

function point(date: string, portfolio: string | null, bench: string | null): Curve[number] {
  return {
    date,
    portfolioValue: portfolio === null ? null : new Decimal(portfolio),
    contributions: null,
    benchmarkValue: bench === null ? null : new Decimal(bench),
  };
}

describe("rebaseBenchmark", () => {
  it("anchors the raw benchmark to the first non-zero portfolio value so it rises", () => {
    const curve: Curve = [
      point("2025-01-01", "30000", "120"),
      point("2025-02-01", "31000", "126"), // benchmark +5%
      point("2025-03-01", "33000", "132"), // benchmark +10%
    ];
    const out = rebaseBenchmark(curve);
    // Starts exactly at the portfolio anchor, then tracks the benchmark's return.
    expect(out[0]!.toNumber()).toBeCloseTo(30000, 6);
    expect(out[1]!.toNumber()).toBeCloseTo(30000 * 1.05, 6);
    expect(out[2]!.toNumber()).toBeCloseTo(30000 * 1.1, 6);
    // The rebased line genuinely climbs (the original bug: it stayed flat/low).
    expect(out[2]!.greaterThan(out[0]!)).toBe(true);
  });

  it("preserves gaps and falls back to raw values without a usable anchor", () => {
    const withGap: Curve = [
      point("2025-01-01", "0", null),
      point("2025-02-01", "0", "120"),
    ];
    // No non-zero portfolio value to anchor on → returns the raw benchmark.
    const out = rebaseBenchmark(withGap);
    expect(out[0]).toBeNull();
    expect(out[1]!.toString()).toBe("120");
  });
});
