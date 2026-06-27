/**
 * Idle auto-lock arithmetic: the timestamp-based decision that guarantees a long
 * absence locks the session the instant the app is reopened, even when the
 * background `setTimeout` was frozen while the tab was hidden or the device
 * asleep.
 */
import { describe, expect, it } from "vitest";

import { autoLockReturnDecision } from "../src/auto-lock";

describe("autoLockReturnDecision", () => {
  const timeoutMs = 5 * 60_000; // 5-minute window

  it("locks immediately once the idle window has fully elapsed while away", () => {
    const lastActivityAt = 1_000_000;
    // Reopened hours later — far past the window — with no timer having fired.
    const decision = autoLockReturnDecision({
      now: lastActivityAt + 4 * 60 * 60_000,
      lastActivityAt,
      timeoutMs,
    });
    expect(decision.lock).toBe(true);
    expect(decision.remainingMs).toBe(0);
  });

  it("locks exactly at the window boundary", () => {
    const lastActivityAt = 1_000_000;
    const decision = autoLockReturnDecision({ now: lastActivityAt + timeoutMs, lastActivityAt, timeoutMs });
    expect(decision.lock).toBe(true);
  });

  it("keeps the session and reports the genuine remaining window when still within it", () => {
    const lastActivityAt = 1_000_000;
    const decision = autoLockReturnDecision({
      now: lastActivityAt + 2 * 60_000, // 2 min in
      lastActivityAt,
      timeoutMs,
    });
    expect(decision.lock).toBe(false);
    expect(decision.remainingMs).toBe(3 * 60_000); // 3 min left
  });

  it("never locks and reports no window when auto-lock is disabled", () => {
    const decision = autoLockReturnDecision({ now: 9_999_999, lastActivityAt: 0, timeoutMs: 0 });
    expect(decision.lock).toBe(false);
    expect(decision.remainingMs).toBe(0);
  });

  it("treats a future-dated activity stamp (clock skew) as 'just now', never a negative window", () => {
    const now = 1_000_000;
    const decision = autoLockReturnDecision({ now, lastActivityAt: now + 30_000, timeoutMs });
    expect(decision.lock).toBe(false);
    expect(decision.remainingMs).toBe(timeoutMs);
  });
});
