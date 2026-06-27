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

/**
 * DOM events that *can* signal a deliberate interaction with the dashboard.
 *
 * Deliberately narrow: passive pointer/touch *movement* (`pointermove`,
 * `touchstart`, `touchmove`), `scroll` and `wheel` are intentionally absent.
 * An absent-minded swipe or scroll over the screen must NOT keep the session
 * unlocked — only a genuine action (a click/tap that lands on a control, a
 * form-control change, or keyboard input) does. See {@link isDeliberateActivity}
 * for how `click`/`change` are further filtered to interactive targets.
 */
export const AUTO_LOCK_ACTIVITY_EVENTS = ["click", "change", "keydown"] as const;

/**
 * CSS selector matching the interactive controls whose use counts as a genuine,
 * deliberate interaction for the idle auto-lock: links, buttons, form controls,
 * `<summary>` (expanding an overview), and anything explicitly made actionable
 * (`role`/`data-action`/focusable `tabindex`). Switching tabs/pages, toggling
 * the currency, picking a graph timeframe and expanding a section all land on
 * one of these; a stray tap on empty chrome does not.
 */
export const DELIBERATE_ACTIVITY_SELECTOR =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [data-action], [tabindex]:not([tabindex="-1"])';

/**
 * Whether a DOM event should count as *deliberate* activity that extends the
 * idle auto-lock window.
 *
 * - `keydown` is always deliberate (you don't type by accident).
 * - `click`/`change` only count when they land on (or inside) an interactive
 *   control per {@link DELIBERATE_ACTIVITY_SELECTOR} — so an accidental tap or
 *   swipe on blank space is ignored and the session keeps counting down.
 *
 * Anything else is treated as non-deliberate.
 */
export function isDeliberateActivity(event: { type: string; target: EventTarget | null }): boolean {
  if (event.type === "keydown") return true;
  if (event.type !== "click" && event.type !== "change") return false;
  const target = event.target;
  if (target && typeof (target as Partial<Element>).closest === "function") {
    return (target as Element).closest(DELIBERATE_ACTIVITY_SELECTOR) !== null;
  }
  return false;
}
