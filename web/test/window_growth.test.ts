/**
 * Tests for the "Value over time" headline growth (`windowGrowthPct`): the
 * little percentage beside the chart must read the selected window, with simple
 * growth for short windows and an XIRR-scaled (money-weighted) growth for longer
 * ones so weekly DCA deposits don't distort it. Pure logic, no DOM.
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

import { windowGrowthPct, type WindowPoint } from "../src/window-growth";

/** Build a window from parallel arrays for terse fixtures. */
function win(
  dates: string[],
  values: Array<number | null>,
  contribs: Array<number | null>,
): WindowPoint[] {
  return dates.map((date, i) => ({
    date,
    value: values[i] === null ? null : new Decimal(values[i] as number),
    contributions: contribs[i] === null ? null : new Decimal(contribs[i] as number),
  }));
}

describe("windowGrowthPct", () => {
  it("returns null for windows with fewer than two valued points", () => {
    expect(windowGrowthPct([], "simple")).toBeNull();
    expect(windowGrowthPct(win(["2026-01-01"], [100], [0]), "xirr")).toBeNull();
    expect(
      windowGrowthPct(win(["2026-01-01", "2026-01-02"], [100, null], [0, 0]), "simple"),
    ).toBeNull();
  });

  it("simple growth with no flows is the plain value ratio", () => {
    // 100 → 110, no contributions: +10%.
    const g = windowGrowthPct(win(["2026-01-01", "2026-01-08"], [100, 110], [0, 0]), "simple");
    expect(g).not.toBeNull();
    expect(g!.toNumber()).toBeCloseTo(0.1, 10);
  });

  it("simple growth nets out a mid-window deposit (Modified Dietz)", () => {
    // Open 100, deposit 50 mid-window, close 165. Dietz: (165-100-50)/(100+25)=0.12
    const g = windowGrowthPct(
      win(["2026-01-01", "2026-01-04", "2026-01-08"], [100, 150, 165], [0, 50, 50]),
      "simple",
    );
    expect(g!.toNumber()).toBeCloseTo(0.12, 10);
  });

  it("xirr-scaled growth de-annualises back to a period return", () => {
    // No flows: the money-weighted rate compounded over the window reproduces the
    // simple value ratio (within solver tolerance).
    const dates = ["2026-01-01", "2026-07-01"];
    const simple = windowGrowthPct(win(dates, [1000, 1100], [0, 0]), "simple");
    const scaled = windowGrowthPct(win(dates, [1000, 1100], [0, 0]), "xirr");
    expect(scaled).not.toBeNull();
    expect(scaled!.toNumber()).toBeCloseTo(simple!.toNumber(), 3);
  });

  it("xirr-scaled growth stays sane with weekly deposits (DCA)", () => {
    // Weekly deposits of 100; value tracks contributions plus a small gain. A
    // naive value/contrib ratio would look wild; the money-weighted return is a
    // modest positive period figure.
    const dates = [
      "2026-01-01",
      "2026-01-08",
      "2026-01-15",
      "2026-01-22",
      "2026-02-01",
    ];
    const contribs = [100, 200, 300, 400, 400];
    const values = [100, 205, 312, 420, 432];
    const g = windowGrowthPct(win(dates, values, contribs), "xirr");
    expect(g).not.toBeNull();
    // A few percent over the month, not a triple-digit artefact.
    expect(g!.toNumber()).toBeGreaterThan(0);
    expect(g!.toNumber()).toBeLessThan(0.2);
  });

  it("falls back to simple growth when the XIRR solver can't run", () => {
    // Same date for open and close → no time span → xirr path returns the simple
    // growth rather than null.
    const g = windowGrowthPct(win(["2026-01-01", "2026-01-01"], [100, 110], [0, 0]), "xirr");
    expect(g!.toNumber()).toBeCloseTo(0.1, 10);
  });
});
