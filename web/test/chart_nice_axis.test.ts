/**
 * The y-axis uses "nice" rounded tick values (1 / 2 / 5 × 10ⁿ) so gridline
 * labels read as round numbers (30k, 32k, …) instead of arbitrary fractions of
 * the raw data range, while staying compact.
 */
import { describe, expect, it } from "vitest";

import { axisFractionDigits, niceAxis } from "../src/chart";

import Decimal from "decimal.js";
import { formatCurrencyShortRaw } from "../src/format";

describe("niceAxis", () => {
  it("rounds the bounds outward and steps on round numbers", () => {
    const axis = niceAxis(30150, 36480);
    // Bounds enclose the data and sit on multiples of the step.
    expect(axis.min).toBeLessThanOrEqual(30150);
    expect(axis.max).toBeGreaterThanOrEqual(36480);
    for (const t of axis.ticks) {
      expect(Number.isInteger(t / axis.step)).toBe(true);
    }
    // Evenly spaced ascending ticks, first = min, last = max.
    expect(axis.ticks[0]).toBe(axis.min);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
  });

  it("uses a step from the 1/2/5 family", () => {
    const { step } = niceAxis(0, 9000);
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    expect([1, 2, 5]).toContain(Math.round(mantissa));
  });

  it("produces several ticks near the target without taking many", () => {
    const axis = niceAxis(30150, 36480);
    expect(axis.ticks.length).toBeGreaterThanOrEqual(3);
    expect(axis.ticks.length).toBeLessThanOrEqual(8);
  });

  it("returns a centred unit band for a flat (equal) range", () => {
    const axis = niceAxis(500, 500);
    expect(axis.min).toBe(499);
    expect(axis.max).toBe(501);
    expect(axis.ticks).toEqual([499, 500, 501]);
  });

  it("is resilient to non-finite input", () => {
    const axis = niceAxis(Number.NaN, Number.NaN);
    expect(axis.ticks.length).toBeGreaterThan(0);
    expect(Number.isFinite(axis.min)).toBe(true);
    expect(Number.isFinite(axis.max)).toBe(true);
  });
});

describe("axisFractionDigits", () => {
  const eurLabel = (v: number, digits?: number): string =>
    formatCurrencyShortRaw(new Decimal(v), "EUR", digits);

  it("adds decimals so a narrow intraday axis no longer reads 47k on every tick", () => {
    // A ~€47k curve with a €200 step would collapse to "€47k" four times over.
    const axis = niceAxis(47_000, 47_600);
    const digits = axisFractionDigits(axis.ticks, axis.step, eurLabel);
    expect(digits).toBeGreaterThanOrEqual(1);
    const labels = axis.ticks.map((t) => eurLabel(t, digits));
    // Every adjacent pair is distinct — the whole point of the fix.
    for (let i = 1; i < labels.length; i += 1) {
      expect(labels[i]).not.toBe(labels[i - 1]);
    }
  });

  it("keeps whole-number labels when the step is already coarse enough", () => {
    const axis = niceAxis(30_000, 38_000);
    const digits = axisFractionDigits(axis.ticks, axis.step, eurLabel);
    expect(digits).toBe(0);
  });

  it("never exceeds the precision cap", () => {
    const axis = niceAxis(47_000, 47_010);
    expect(axisFractionDigits(axis.ticks, axis.step, eurLabel)).toBeLessThanOrEqual(3);
  });
});
