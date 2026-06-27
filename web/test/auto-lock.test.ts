/**
 * Idle auto-lock arithmetic: the timestamp-based decision that guarantees a long
 * absence locks the session the instant the app is reopened, even when the
 * background `setTimeout` was frozen while the tab was hidden or the device
 * asleep.
 */
import { describe, expect, it } from "vitest";

import {
  AUTO_LOCK_ACTIVITY_EVENTS,
  autoLockReturnDecision,
  isDeliberateActivity,
} from "../src/auto-lock";

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

describe("isDeliberateActivity", () => {
  // A stand-in DOM target whose `closest` reports whether it sits inside an
  // interactive control, mirroring Element.closest without needing jsdom.
  const target = (hit: boolean): { closest: (sel: string) => unknown } => ({
    closest: () => (hit ? {} : null),
  });

  it("only lists deliberate event types (no passive movement/scroll/touch)", () => {
    expect([...AUTO_LOCK_ACTIVITY_EVENTS]).toEqual(["click", "change", "keydown"]);
    for (const passive of ["pointerdown", "pointermove", "touchstart", "touchmove", "scroll", "wheel"]) {
      expect(AUTO_LOCK_ACTIVITY_EVENTS).not.toContain(passive);
    }
  });

  it("always counts keyboard input as deliberate", () => {
    expect(isDeliberateActivity({ type: "keydown", target: null })).toBe(true);
  });

  it("counts a click/change only when it lands on an interactive control", () => {
    expect(isDeliberateActivity({ type: "click", target: target(true) as unknown as EventTarget })).toBe(true);
    expect(isDeliberateActivity({ type: "change", target: target(true) as unknown as EventTarget })).toBe(true);
  });

  it("ignores a click/tap that lands on blank, non-interactive chrome", () => {
    // e.g. an absent-minded tap/swipe that doesn't hit a button, tab, etc.
    expect(isDeliberateActivity({ type: "click", target: target(false) as unknown as EventTarget })).toBe(false);
    expect(isDeliberateActivity({ type: "click", target: null })).toBe(false);
  });

  it("ignores passive movement/scroll events entirely", () => {
    for (const type of ["scroll", "wheel", "touchstart", "pointerdown", "pointermove"]) {
      expect(isDeliberateActivity({ type, target: target(true) as unknown as EventTarget })).toBe(false);
    }
  });
});
