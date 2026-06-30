import { describe, expect, it } from "vitest";

import type { StorageLike } from "../src/cache";
import { buildProviderUsage, isAtLimit } from "../src/provider-usage";

/** Minimal in-memory StorageLike for injecting credit ledgers. */
function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

const CREDIT_KEY = "iv.web.credit_log";
const TIINGO_CREDIT_KEY = "iv.web.tiingo_credit_log";

describe("buildProviderUsage", () => {
  it("reports zero usage with empty ledgers and the free-tier caps", () => {
    const usage = buildProviderUsage(Date.now(), memoryStorage());
    expect(usage.twelveDataPerMinute.used).toBe(0);
    expect(usage.twelveDataPerMinute.cap).toBe(8);
    expect(usage.twelveDataPerDay.cap).toBe(800);
    expect(usage.tiingoPerDay.cap).toBe(800);
  });

  it("sums Twelve Data spend within the rolling minute and the day", () => {
    const now = 1_000_000_000_000;
    const log = JSON.stringify([
      { at: now - 30_000, n: 3 }, // within the minute and the day
      { at: now - 2 * 60_000, n: 2 }, // older than a minute, same day
    ]);
    const usage = buildProviderUsage(now, memoryStorage({ [CREDIT_KEY]: log }));
    expect(usage.twelveDataPerMinute.used).toBe(3);
    expect(usage.twelveDataPerDay.used).toBe(5);
  });

  it("reads the Tiingo ledger for the per-day window", () => {
    const now = 1_000_000_000_000;
    const log = JSON.stringify([{ at: now - 60_000, n: 4 }]);
    const usage = buildProviderUsage(now, memoryStorage({ [TIINGO_CREDIT_KEY]: log }));
    expect(usage.tiingoPerDay.used).toBe(4);
  });

  it("flags a window at its cap via isAtLimit", () => {
    expect(isAtLimit({ used: 8, cap: 8, resets: "x" })).toBe(true);
    expect(isAtLimit({ used: 7, cap: 8, resets: "x" })).toBe(false);
  });
});
