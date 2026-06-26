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
  MIN_BURST_RELIEF_MS,
  MIN_JUMPSTART_DELAY_MS,
  dailyBudgetSlowdown,
  jumpstartDelayMs,
  minuteBudgetReliefMs,
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

describe("minuteBudgetReliefMs", () => {
  const MIN = 60 * 1000;

  it("returns null when no credits sit in the trailing window", () => {
    // The only spend is older than a minute → already aged out, no relief owed.
    expect(minuteBudgetReliefMs([1000], 1000 + MIN + 5, MIN)).toBeNull();
    expect(minuteBudgetReliefMs([], 5000, MIN)).toBeNull();
  });

  it("counts down to when the oldest in-window credit ages out", () => {
    // A credit spent 40 s ago frees 20 s from now (60 s window).
    const now = 100_000;
    const relief = minuteBudgetReliefMs([now - 40_000], now, MIN);
    expect(relief).toBe(20_000);
  });

  it("anchors on the OLDEST in-window spend, ignoring fresher ones", () => {
    const now = 100_000;
    // Spends 50 s and 10 s ago: the older frees first (in 10 s), so that wins.
    expect(minuteBudgetReliefMs([now - 50_000, now - 10_000], now, MIN)).toBe(10_000);
  });

  it("floors a just-expiring credit so the burst can't spin hot", () => {
    const now = 100_000;
    // Spend 59.9 s ago would free in 100 ms; floored to MIN_BURST_RELIEF_MS.
    const relief = minuteBudgetReliefMs([now - (MIN - 100)], now, MIN, MIN_BURST_RELIEF_MS);
    expect(relief).toBe(MIN_BURST_RELIEF_MS);
  });

  it("is never longer than a full window (so it only ever brings the burst forward)", () => {
    const now = 100_000;
    // A spend at exactly now frees a full minute out — the worst case, == a blind burst.
    expect(minuteBudgetReliefMs([now], now, MIN)).toBe(MIN);
  });
});

describe("jumpstartDelayMs", () => {
  const interval = 15 * 60 * 1000; // 15-minute auto-update window.
  const now = 1_700_000_000_000;

  it("returns the ms until the oldest still-fresh value reaches the window", () => {
    // Oldest value observed 12 min ago on a 15-min window ⇒ ~3 min remaining.
    const oldestAt = now - 12 * 60 * 1000;
    expect(jumpstartDelayMs(oldestAt, interval, now)).toBe(3 * 60 * 1000);
  });

  it("returns null (not 0) when the oldest value is already past the window", () => {
    // Regression: a value older than the interval (e.g. held FX) must NOT
    // collapse the delay to 0 and spin a 0ms runaway refresh loop.
    const stale = now - 20 * 60 * 1000;
    expect(jumpstartDelayMs(stale, interval, now)).toBeNull();
  });

  it("returns null exactly at the window boundary", () => {
    expect(jumpstartDelayMs(now - interval, interval, now)).toBeNull();
  });

  it("floors a near-expiry anchor at the minimum jumpstart delay", () => {
    // 30 s left would otherwise schedule a near-immediate re-fire; floor it.
    const oldestAt = now - (interval - 30 * 1000);
    expect(jumpstartDelayMs(oldestAt, interval, now)).toBe(MIN_JUMPSTART_DELAY_MS);
  });

  it("returns null when there is no anchor value", () => {
    expect(jumpstartDelayMs(null, interval, now)).toBeNull();
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
