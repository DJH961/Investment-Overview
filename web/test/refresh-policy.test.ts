/**
 * Tests for the auto-refresh cadence policy: burst while symbols are still being
 * filled in, then relax to a slow steady-state cadence.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BURST_INTERVAL_MS,
  DEFAULT_SLOW_INTERVAL_MS,
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
});
