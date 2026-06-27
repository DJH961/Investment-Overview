/**
 * Pure idle auto-lock arithmetic, kept free of DOM/timer wiring so it can be
 * unit-tested in isolation.
 *
 * Why this exists: the live auto-lock in {@link App} arms a `setTimeout` to fire
 * the lock after the idle window. But background tabs get frozen/throttled by the
 * browser (and the device may sleep entirely), so that timer is **not** a
 * reliable clock — when the user comes back after a long absence the timer may
 * not have fired, leaving the session unlocked. The robust signal is wall-clock
 * elapsed time since the last genuine interaction. On every "the app is shown
 * again" event (visibility/pageshow/focus) we recompute from that timestamp and
 * either lock immediately or re-arm for the genuine remaining window.
 */

/** What to do with the idle auto-lock when the app becomes visible again. */
export interface AutoLockReturnDecision {
  /** Lock the session right now: the idle window has fully elapsed while away. */
  lock: boolean;
  /** When not locking, the genuine remaining time (ms) before the lock is due. */
  remainingMs: number;
}

/**
 * Decide, purely from timestamps, what the idle auto-lock should do the moment
 * the app is shown again after being hidden/backgrounded.
 *
 * - `timeoutMs <= 0` ("never lock") → never lock, no remaining window.
 * - elapsed idle ≥ the window → lock now (this is the case a frozen background
 *   `setTimeout` would otherwise miss).
 * - otherwise → keep the session, with the real remaining window so the timer
 *   can be re-armed (rather than trusting a possibly-stalled background timer).
 *
 * A small future-dated `lastActivityAt` (clock nudge/DST) is treated as "just
 * now" so a skewed clock can never produce a negative remaining window.
 */
export function autoLockReturnDecision(args: {
  now: number;
  lastActivityAt: number;
  timeoutMs: number;
}): AutoLockReturnDecision {
  if (args.timeoutMs <= 0) return { lock: false, remainingMs: 0 };
  const elapsed = Math.max(0, args.now - args.lastActivityAt);
  if (elapsed >= args.timeoutMs) return { lock: true, remainingMs: 0 };
  return { lock: false, remainingMs: args.timeoutMs - elapsed };
}
