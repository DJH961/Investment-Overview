/**
 * Demo clock — makes the offline demo read as a **live US market day**, every
 * time it is opened.
 *
 * The app reads the wall clock in ~180 places (`Date.now()`, `new Date()`), so the
 * clock is faked globally rather than per call site: `installDemoClock` swaps the
 * global `Date` for a subclass whose no-argument constructor and `Date.now()`
 * return a *shifted* instant. Everything else (`Date.parse`, `Date.UTC`,
 * `new Date(x)`, `performance.now`, timers) is untouched, so only "now" moves.
 *
 * The shifted "now" is **11:42 ET on the most recent NYSE trading day on or
 * before the real New-York date**, then advances in real time and freezes at
 * 15:58 ET so a long-open tab never crosses the close.
 */
import { exchangeDate, isUsTradingDay, previousTradingSession, sessionOpenMs } from "./market-hours";

/** Minutes after the 09:30 ET open at which a freshly loaded demo starts (11:42 ET). */
const START_OFFSET_MIN = 2 * 60 + 12;
/** Minutes after the open at which the demo clock stops (15:58 ET). */
const FREEZE_OFFSET_MIN = 6 * 60 + 28;

const RealDate: DateConstructor = Date;

let installed = false;
let offsetMs = 0;
let freezeMs = Number.POSITIVE_INFINITY;

/** Today's NYSE trading day for the demo: the real New-York date, walked back past weekends/holidays. */
export function demoTradingDay(realNowMs: number = RealDate.now()): string {
  const iso = exchangeDate(new RealDate(realNowMs));
  const noon = new RealDate(`${iso}T12:00:00Z`);
  return isUsTradingDay(noon) ? iso : previousTradingSession(iso);
}

/** The `[start, freeze]` shifted-clock instants (epoch ms) for a demo trading day. */
export function demoClockWindow(day: string): { startMs: number; freezeMs: number } {
  const open = sessionOpenMs(day);
  return { startMs: open + START_OFFSET_MIN * 60_000, freezeMs: open + FREEZE_OFFSET_MIN * 60_000 };
}

/** Whether the shifted demo clock is currently installed. */
export function isDemoClockInstalled(): boolean {
  return installed;
}

function shiftedNow(): number {
  return Math.min(RealDate.now() + offsetMs, freezeMs);
}

/**
 * Install the shifted clock (idempotent). `realNowMs` is injectable for tests.
 * Returns the demo trading day it is anchored to.
 */
export function installDemoClock(realNowMs: number = RealDate.now()): string {
  const day = demoTradingDay(realNowMs);
  if (installed) return day;
  const window = demoClockWindow(day);
  offsetMs = window.startMs - realNowMs;
  freezeMs = window.freezeMs;

  class DemoDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(shiftedNow());
      else super(...(args as [number]));
    }
    static now(): number {
      return shiftedNow();
    }
    // Real `Date` instances (made before the swap, or by Intl) still count.
    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof RealDate;
    }
  }
  globalThis.Date = DemoDate as unknown as DateConstructor;
  installed = true;
  return day;
}

/** Put the real `Date` back (no-op when not installed). */
export function uninstallDemoClock(): void {
  if (!installed) return;
  globalThis.Date = RealDate;
  installed = false;
  offsetMs = 0;
  freezeMs = Number.POSITIVE_INFINITY;
}
