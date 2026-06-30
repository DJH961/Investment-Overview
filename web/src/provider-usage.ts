/**
 * Read-only **provider budget usage** snapshot for the Settings screen.
 *
 * The desktop app's Connectivity panel shows live Tiingo usage (used/cap, when
 * it resets); this mirrors that on the web companion for its primary provider,
 * Twelve Data, plus the Tiingo fallback. It is a pure read over the same credit
 * ledgers the live-data budget already maintains (`cache.ts`) and the user's
 * configured caps (`provider-limits.ts`) — it spends nothing and never mutates
 * state, so it is safe to call on every Settings render and unit-testable in
 * isolation.
 *
 * Twelve Data resets its per-minute window continuously and its daily allowance
 * at 00:00 UTC; the Tiingo free tier resets daily at midnight US/Eastern. The
 * snapshot reports each used count against the matching configured cap.
 */

import {
  creditsSpentToday,
  creditsSpentWithin,
  readCreditLog,
  readTiingoCreditLog,
  tiingoCreditsSpentToday,
  type StorageLike,
} from "./cache";
import { providerLimits } from "./provider-limits";

/** One provider's used/cap pair for a given reset window. */
export interface UsageWindow {
  used: number;
  cap: number;
  /** A short, human label for when the window resets. */
  resets: string;
}

/** A full read-only usage snapshot across both providers. */
export interface ProviderUsage {
  twelveDataPerMinute: UsageWindow;
  twelveDataPerDay: UsageWindow;
  tiingoPerDay: UsageWindow;
}

const MINUTE_MS = 60 * 1000;

/**
 * Build the current usage snapshot. `now` is injectable (defaults to the wall
 * clock) and `storage` is injectable for tests; both default to live values.
 * Used counts are floored at 0 so an in-flight refund can't show a negative.
 */
export function buildProviderUsage(
  now: number = Date.now(),
  storage: StorageLike | null = null,
): ProviderUsage {
  const limits = providerLimits();
  const tdLog = storage ? readCreditLog(now, 24 * 60 * 60 * 1000, storage) : readCreditLog(now);
  const tiingoLog = storage
    ? readTiingoCreditLog(now, 24 * 60 * 60 * 1000, storage)
    : readTiingoCreditLog(now);
  return {
    twelveDataPerMinute: {
      used: Math.max(0, creditsSpentWithin(tdLog, now, MINUTE_MS)),
      cap: limits.twelveDataPerMinute,
      resets: "rolling 60s",
    },
    twelveDataPerDay: {
      used: Math.max(0, creditsSpentToday(tdLog, now)),
      cap: limits.twelveDataPerDay,
      resets: "00:00 UTC",
    },
    tiingoPerDay: {
      used: Math.max(0, tiingoCreditsSpentToday(tiingoLog, now)),
      cap: limits.tiingoPerDay,
      resets: "00:00 US/Eastern",
    },
  };
}

/** Whether a usage window is at or over its cap (for an "at limit" badge). */
export function isAtLimit(window: UsageWindow): boolean {
  return window.used >= window.cap;
}
