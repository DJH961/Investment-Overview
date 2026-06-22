/**
 * Tests for the auto-refresh cadence policy: burst while symbols are still being
 * filled in, then relax to a slow steady-state cadence.
 */
import { describe, expect, it } from "vitest";

import {
  BUDGET_EASE_THRESHOLD,
  DEFAULT_BURST_INTERVAL_MS,
  DEFAULT_DAY_CREDIT_LIMIT,
  DEFAULT_SLOW_INTERVAL_MS,
  MAX_BUDGET_SLOWDOWN,
  dailyBudgetSlowdown,
  nextRefreshDelayMs,
} from "../src/refresh-policy";

describe("nextRefreshDelayMs", () => {
  it("bursts (≈one minute) while symbols are still deferred", () => {
    const delay = nextRefreshDelayMs({ deferred: ["A", "B"] }, { jitterMs: 0 });
    expect(delay).toBe(DEFAULT_BURST_INTERVAL_MS);
  });

  it("relaxes to the slow cadence once nothing is deferred", () => {
    const delay = nextRefreshDelayMs({ deferred: [] }, { jitterMs: 0 });
    expect(delay).toBe(DEFAULT_SLOW_INTERVAL_MS);
  });

  it("honours custom intervals and adds jitter", () => {
    expect(nextRefreshDelayMs({ deferred: ["X"] }, { burstIntervalMs: 1000, jitterMs: 7 })).toBe(1007);
    expect(nextRefreshDelayMs({ deferred: [] }, { slowIntervalMs: 9000, jitterMs: 7 })).toBe(9007);
  });

  it("the burst interval is shorter than the slow one", () => {
    expect(DEFAULT_BURST_INTERVAL_MS).toBeLessThan(DEFAULT_SLOW_INTERVAL_MS);
  });

  it("spaces refreshes out as the daily budget runs low", () => {
    const plenty = nextRefreshDelayMs({ deferred: [], dayRemaining: 800 }, { jitterMs: 0 });
    const low = nextRefreshDelayMs({ deferred: [], dayRemaining: 40 }, { jitterMs: 0 });
    expect(plenty).toBe(DEFAULT_SLOW_INTERVAL_MS);
    expect(low).toBeGreaterThan(plenty);
  });

  it("backs right off once the daily budget is exhausted", () => {
    const delay = nextRefreshDelayMs({ deferred: [], dayRemaining: 0 }, { jitterMs: 0 });
    expect(delay).toBe(DEFAULT_SLOW_INTERVAL_MS * MAX_BUDGET_SLOWDOWN);
  });

  it("ignores daily pacing when no budget is supplied (back-compat)", () => {
    expect(nextRefreshDelayMs({ deferred: [] }, { jitterMs: 0 })).toBe(DEFAULT_SLOW_INTERVAL_MS);
  });
});

describe("dailyBudgetSlowdown", () => {
  it("is 1× while well within the daily budget", () => {
    expect(dailyBudgetSlowdown(DEFAULT_DAY_CREDIT_LIMIT)).toBe(1);
    // Exactly at the ease threshold is still 1×.
    const atThreshold = DEFAULT_DAY_CREDIT_LIMIT * (1 - BUDGET_EASE_THRESHOLD);
    expect(dailyBudgetSlowdown(atThreshold)).toBe(1);
  });

  it("ramps up monotonically as the budget shrinks", () => {
    const a = dailyBudgetSlowdown(150);
    const b = dailyBudgetSlowdown(80);
    const c = dailyBudgetSlowdown(10);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThanOrEqual(MAX_BUDGET_SLOWDOWN);
  });

  it("pins to the max once nothing is left", () => {
    expect(dailyBudgetSlowdown(0)).toBe(MAX_BUDGET_SLOWDOWN);
    expect(dailyBudgetSlowdown(-5)).toBe(MAX_BUDGET_SLOWDOWN);
  });

  it("disables pacing when the remaining budget is unknown", () => {
    expect(dailyBudgetSlowdown(undefined)).toBe(1);
  });
});
