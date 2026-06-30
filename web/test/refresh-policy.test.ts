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
  MIN_STALE_ROUND_ABORT_MS,
  STALE_ROUND_INTERVAL_MULTIPLIER,
  DEFAULT_WAKE_COALESCE_MS,
  burstReliefMs,
  burstFillDetail,
  dailyBudgetSlowdown,
  jumpstartDelayMs,
  minuteBudgetReliefMs,
  nextRefreshDelayMs,
  prefetchDebounceMs,
  prefetchDebounceActive,
  roundIsStale,
  staleRoundAbortMs,
  wakeCoalesceActive,
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

describe("burstReliefMs (429-breaker cooperation)", () => {
  const MIN = 60 * 1000;

  it("matches minuteBudgetReliefMs when the provider is not frozen", () => {
    const now = 100_000;
    expect(burstReliefMs([now - 40_000], now)).toBe(20_000);
    expect(burstReliefMs([now - 40_000], now, { frozen: false })).toBe(20_000);
  });

  it("honours the window/floor options like minuteBudgetReliefMs", () => {
    const now = 100_000;
    // 59.9 s ago would free in 100 ms; floored to MIN_BURST_RELIEF_MS.
    expect(burstReliefMs([now - (MIN - 100)], now, { windowMs: MIN, floorMs: MIN_BURST_RELIEF_MS })).toBe(
      MIN_BURST_RELIEF_MS,
    );
  });

  it("returns null while frozen, so no early burst is scheduled against a 429-frozen provider", () => {
    const now = 100_000;
    // Without the freeze this would bring the burst forward to 20 s; the freeze
    // suppresses it so the caller keeps its normal (also breaker-gated) cadence.
    expect(burstReliefMs([now - 40_000], now, { frozen: true })).toBeNull();
    // Even a credit on the verge of ageing out yields no relief while frozen.
    expect(burstReliefMs([now - 1_000], now, { frozen: true, floorMs: MIN_BURST_RELIEF_MS })).toBeNull();
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

describe("prefetchDebounceMs", () => {
  it("is half the auto-update cycle", () => {
    expect(prefetchDebounceMs(20 * 60 * 1000)).toBe(10 * 60 * 1000);
    expect(prefetchDebounceMs(8 * 60 * 1000)).toBe(4 * 60 * 1000);
  });

  it("floors a tiny interval at the burst floor so the gate is never disabled", () => {
    expect(prefetchDebounceMs(30 * 1000)).toBe(MIN_JUMPSTART_DELAY_MS);
  });
});

describe("prefetchDebounceActive", () => {
  const now = 1_700_000_000_000;
  const interval = 20 * 60 * 1000; // half = 10 min

  it("debounces a reload within half the cycle (skip the duplicate warm-up)", () => {
    expect(prefetchDebounceActive(now - 5 * 60 * 1000, now, interval)).toBe(true);
  });

  it("warms again once half the cycle has elapsed", () => {
    expect(prefetchDebounceActive(now - 10 * 60 * 1000, now, interval)).toBe(false);
    expect(prefetchDebounceActive(now - 15 * 60 * 1000, now, interval)).toBe(false);
  });

  it("warms on a first-ever load (no prior prefetch)", () => {
    expect(prefetchDebounceActive(null, now, interval)).toBe(false);
  });

  it("warms when the stamp is in the future (clock skew)", () => {
    expect(prefetchDebounceActive(now + 5 * 60 * 1000, now, interval)).toBe(false);
  });
});

describe("staleRoundAbortMs", () => {
  it("scales with the configured interval (× the multiplier)", () => {
    const interval = 15 * 60 * 1000;
    expect(staleRoundAbortMs(interval)).toBe(interval * STALE_ROUND_INTERVAL_MULTIPLIER);
  });

  it("floors a short interval so a genuinely-slow round still finishes", () => {
    // 5s × 3 = 15s, well under the floor.
    expect(staleRoundAbortMs(5_000)).toBe(MIN_STALE_ROUND_ABORT_MS);
  });

  it("floors a zero / non-finite interval", () => {
    expect(staleRoundAbortMs(0)).toBe(MIN_STALE_ROUND_ABORT_MS);
    expect(staleRoundAbortMs(Number.NaN)).toBe(MIN_STALE_ROUND_ABORT_MS);
  });
});

describe("roundIsStale", () => {
  const now = 1_700_000_000_000;
  const interval = 2 * 60 * 1000; // abort threshold = max(90s, 6 minutes) = 6 minutes

  it("is false when no round is in flight", () => {
    expect(roundIsStale(null, now, interval)).toBe(false);
  });

  it("is false for a freshly-started round", () => {
    expect(roundIsStale(now - 1_000, now, interval)).toBe(false);
  });

  it("is false right up to the abort threshold", () => {
    expect(roundIsStale(now - (staleRoundAbortMs(interval) - 1), now, interval)).toBe(false);
  });

  it("is true once a round has run past the abort threshold (the log-44 hour-long round)", () => {
    expect(roundIsStale(now - 60 * 60 * 1000, now, interval)).toBe(true);
  });

  it("is false when the start stamp is in the future (clock skew)", () => {
    expect(roundIsStale(now + 5_000, now, interval)).toBe(false);
  });
});

describe("wakeCoalesceActive", () => {
  const now = 1_700_000_000_000;

  it("suppresses a second wake within the window (collapse the resume storm)", () => {
    expect(wakeCoalesceActive(now - 1_000, now)).toBe(true);
  });

  it("lets a wake run once the window has elapsed", () => {
    expect(wakeCoalesceActive(now - (DEFAULT_WAKE_COALESCE_MS + 1), now)).toBe(false);
  });

  it("runs the first-ever wake (no prior recorded)", () => {
    expect(wakeCoalesceActive(null, now)).toBe(false);
  });

  it("runs when the stamp is in the future (clock skew)", () => {
    expect(wakeCoalesceActive(now + 1_000, now)).toBe(false);
  });

  it("honours a custom window", () => {
    expect(wakeCoalesceActive(now - 2_000, now, 1_000)).toBe(false);
    expect(wakeCoalesceActive(now - 500, now, 1_000)).toBe(true);
  });
});

describe("burstFillDetail", () => {
  it("is empty when nothing is left to fill (take the pill down)", () => {
    expect(burstFillDetail(0)).toBe("");
    expect(burstFillDetail(-1)).toBe("");
    expect(burstFillDetail(Number.NaN)).toBe("");
  });

  it("uses the singular for a lone remaining holding", () => {
    expect(burstFillDetail(1)).toBe("1 holding still filling in");
  });

  it("pluralises for several remaining holdings", () => {
    expect(burstFillDetail(4)).toBe("4 holdings still filling in");
  });
});
