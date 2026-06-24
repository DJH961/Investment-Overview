import { beforeEach, describe, expect, it } from "vitest";

import {
  TD_FREEZE_MS,
  TD_ESCALATED_FREEZE_MS,
  applyTwelveDataFreeze,
  clearProviderBreaker,
  recordTiingo429,
  recordTwelveData429,
  recordTwelveDataSuccess,
  tiingoFrozen,
  twelveDataFrozen,
} from "../src/provider-breaker";
import type { StorageLike } from "../src/cache";

/** A minimal in-memory localStorage stand-in for the persisted breaker state. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("provider-breaker — Twelve Data 429 freeze (WS4/WS5)", () => {
  let store: StorageLike;
  beforeEach(() => {
    store = memoryStorage();
  });

  it("is not frozen before any 429", () => {
    expect(twelveDataFrozen(1_000, store)).toBe(false);
  });

  it("freezes for ~60s on a first 429, then lifts", () => {
    const now = 1_000_000;
    recordTwelveData429(now, store);
    expect(twelveDataFrozen(now, store)).toBe(true);
    expect(twelveDataFrozen(now + TD_FREEZE_MS - 1, store)).toBe(true);
    expect(twelveDataFrozen(now + TD_FREEZE_MS, store)).toBe(false);
  });

  it("escalates to ~2min on a second consecutive 429, then resets the cycle", () => {
    const now = 2_000_000;
    recordTwelveData429(now, store); // strike 1 → 60s
    recordTwelveData429(now, store); // strike 2 → 2min, streak reset
    expect(twelveDataFrozen(now + TD_FREEZE_MS, store)).toBe(true);
    expect(twelveDataFrozen(now + TD_ESCALATED_FREEZE_MS - 1, store)).toBe(true);
    expect(twelveDataFrozen(now + TD_ESCALATED_FREEZE_MS, store)).toBe(false);
    // A third consecutive 429 starts the cycle fresh at 60s (not another 2min).
    const later = now + TD_ESCALATED_FREEZE_MS;
    recordTwelveData429(later, store);
    expect(twelveDataFrozen(later + TD_FREEZE_MS - 1, store)).toBe(true);
    expect(twelveDataFrozen(later + TD_FREEZE_MS, store)).toBe(false);
  });

  it("a successful call clears the streak, so the next 429 is only 60s", () => {
    const now = 3_000_000;
    recordTwelveData429(now, store); // strike 1
    recordTwelveDataSuccess(store); // streak cleared
    recordTwelveData429(now, store); // back to strike 1 → 60s, not escalated
    expect(twelveDataFrozen(now + TD_FREEZE_MS - 1, store)).toBe(true);
    expect(twelveDataFrozen(now + TD_FREEZE_MS, store)).toBe(false);
  });

  it("zeroes the Twelve Data minute budget while frozen, untouched otherwise", () => {
    const now = 4_000_000;
    const budget = { minute: 8, day: 800 };
    expect(applyTwelveDataFreeze(budget, now, store)).toEqual(budget);
    recordTwelveData429(now, store);
    expect(applyTwelveDataFreeze(budget, now, store)).toEqual({ minute: 0, day: 800 });
    expect(applyTwelveDataFreeze(budget, now + TD_FREEZE_MS, store)).toEqual(budget);
  });
});

describe("provider-breaker — Tiingo 429 freeze to the next :00 (WS4/WS5)", () => {
  let store: StorageLike;
  beforeEach(() => {
    store = memoryStorage();
  });

  it("freezes Tiingo until the next clock hour, then auto-clears", () => {
    // 14:31:05 UTC — the next :00 is 15:00:00 UTC.
    const now = Date.parse("2026-06-24T14:31:05Z");
    const nextHour = Date.parse("2026-06-24T15:00:00Z");
    recordTiingo429(now, store);
    expect(tiingoFrozen(now, store)).toBe(true);
    expect(tiingoFrozen(nextHour - 1, store)).toBe(true);
    expect(tiingoFrozen(nextHour, store)).toBe(false);
  });

  it("is independent of the Twelve Data breaker", () => {
    const now = Date.parse("2026-06-24T14:31:05Z");
    recordTiingo429(now, store);
    expect(twelveDataFrozen(now, store)).toBe(false);
  });
});

describe("provider-breaker — persistence and reset", () => {
  it("persists across reads and clears on reset", () => {
    const store = memoryStorage();
    const now = 5_000_000;
    recordTwelveData429(now, store);
    expect(twelveDataFrozen(now, store)).toBe(true);
    clearProviderBreaker(store);
    expect(twelveDataFrozen(now, store)).toBe(false);
  });
});
