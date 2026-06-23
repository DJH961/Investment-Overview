/**
 * Tests for the Tiingo-specific cache primitives: the separate ET-reset budget
 * log and the persisted canary / quick-refresh state.
 */
import { describe, expect, it } from "vitest";

import {
  startOfEtDay,
  readTiingoCreditLog,
  recordTiingoCredits,
  tiingoCreditsSpentToday,
  creditsSpentWithin,
  readTiingoState,
  writeTiingoState,
  type StorageLike,
} from "../src/cache";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("startOfEtDay", () => {
  it("lands on ET midnight (UTC-4 in June)", () => {
    const noonEt = Date.UTC(2026, 5, 22, 16, 0, 0); // 12:00 ET
    const start = startOfEtDay(noonEt);
    // ET midnight on 2026-06-22 is 04:00 UTC.
    expect(new Date(start).toISOString()).toBe("2026-06-22T04:00:00.000Z");
  });

  it("is a fixed point for an instant already at ET midnight", () => {
    const etMidnight = Date.UTC(2026, 5, 22, 4, 0, 0);
    expect(startOfEtDay(etMidnight)).toBe(etMidnight);
  });
});

describe("Tiingo credit log", () => {
  it("records and reads back spends, separate from Twelve Data", () => {
    const s = memStorage();
    const now = Date.UTC(2026, 5, 22, 18, 0, 0);
    recordTiingoCredits(3, now, s);
    recordTiingoCredits(2, now + 1000, s);
    const log = readTiingoCreditLog(now + 2000, undefined, s);
    expect(creditsSpentWithin(log, now + 2000, 60 * 60 * 1000)).toBe(5);
  });

  it("counts today's spend from ET midnight, not a rolling 24h", () => {
    const s = memStorage();
    const lateYesterdayEt = Date.UTC(2026, 5, 22, 2, 0, 0); // 22:00 ET on the 21st
    const middayEt = Date.UTC(2026, 5, 22, 16, 0, 0); // 12:00 ET on the 22nd
    recordTiingoCredits(4, lateYesterdayEt, s);
    recordTiingoCredits(1, middayEt, s);
    const log = readTiingoCreditLog(middayEt, undefined, s);
    // Only the post-ET-midnight spend counts toward today.
    expect(tiingoCreditsSpentToday(log, middayEt)).toBe(1);
  });
});

describe("Tiingo state", () => {
  it("defaults to an empty state and round-trips", () => {
    const s = memStorage();
    expect(readTiingoState(s)).toEqual({
      canaryDay: null,
      canaryCount: 0,
      lastCanaryAt: null,
      lastQuickRefreshAt: null,
    });
    writeTiingoState({ canaryDay: "2026-06-22", canaryCount: 2, lastCanaryAt: 123, lastQuickRefreshAt: 456 }, s);
    expect(readTiingoState(s)).toEqual({
      canaryDay: "2026-06-22",
      canaryCount: 2,
      lastCanaryAt: 123,
      lastQuickRefreshAt: 456,
    });
  });
});
