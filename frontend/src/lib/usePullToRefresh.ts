import { useEffect, useRef, useState } from "react";

/** Pull distance (after resistance) that triggers a refresh when released. */
export const PULL_THRESHOLD = 64;
/** The indicator never travels further than this. */
export const PULL_MAX = 96;
/** Finger travel is halved so the pull feels elastic. */
const RESISTANCE = 0.5;

/** Visible offset for a raw finger travel of `dy` px (negative = pushing up). */
export function pullOffset(dy: number): number {
  if (dy <= 0) return 0;
  return Math.min(PULL_MAX, dy * RESISTANCE);
}

/**
 * Touch gesture state machine, kept free of the DOM so it can be unit tested.
 * A pull only arms when the page is scrolled to the very top at touch start
 * and the touch did not start inside something that scrolls on its own.
 */
export class PullTracker {
  private startY: number | null = null;
  private offset = 0;

  start(y: number, atTop: boolean, ignored = false): void {
    this.startY = atTop && !ignored ? y : null;
    this.offset = 0;
  }

  /** Returns the current visible offset (0 when not pulling). */
  move(y: number): number {
    if (this.startY === null) return 0;
    this.offset = pullOffset(y - this.startY);
    return this.offset;
  }

  /** Ends the gesture; true when it was pulled past the threshold. */
  end(): boolean {
    const fire = this.startY !== null && this.offset >= PULL_THRESHOLD;
    this.startY = null;
    this.offset = 0;
    return fire;
  }

  cancel(): void {
    this.startY = null;
    this.offset = 0;
  }
}

/** True when the element (or an ancestor below the page) is a dialog or is itself scrolled down. */
function startsInsideScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  if (el?.closest('[role="dialog"], [role="menu"]')) return true;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.scrollTop > 0) return true;
    el = el.parentElement;
  }
  return false;
}

function pageAtTop(): boolean {
  return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
}

export interface PullToRefreshOptions {
  /** Phone only; also off while a refresh runs. */
  enabled: boolean;
  onRefresh: () => void;
}

/**
 * Phone pull-to-refresh on the document. Listeners are passive (normal
 * scrolling is never blocked). While enabled the browser's own pull-to-reload
 * is turned off with `overscroll-behavior-y: contain`, so the gesture refreshes
 * data instead of reloading the app. The top-bar Refresh button is the
 * accessible equivalent; this is only a shortcut.
 */
export function usePullToRefresh({ enabled, onRefresh }: PullToRefreshOptions): { offset: number; armed: boolean } {
  const [offset, setOffset] = useState(0);
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  });

  useEffect(() => {
    if (!enabled) return;
    const tracker = new PullTracker();
    const root = document.documentElement;
    const previous = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = "contain";

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return tracker.cancel();
      tracker.start(e.touches[0].clientY, pageAtTop(), startsInsideScroller(e.target));
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracker.cancel();
        setOffset(0);
        return;
      }
      setOffset(tracker.move(e.touches[0].clientY));
    };
    const onEnd = () => {
      if (tracker.end()) refreshRef.current();
      setOffset(0);
    };
    const onCancel = () => {
      tracker.cancel();
      setOffset(0);
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      root.style.overscrollBehaviorY = previous;
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, [enabled]);

  // A gesture in flight when the hook gets disabled (a refresh started) shows nothing.
  const shown = enabled ? offset : 0;
  return { offset: shown, armed: shown >= PULL_THRESHOLD };
}
