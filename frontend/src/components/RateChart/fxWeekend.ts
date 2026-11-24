import { useEffect, useState } from "react";

/**
 * The spot-FX week (mirrors `domain/market_hours.is_forex_market_open`): forex trades
 * round the clock from Sunday 17:00 to Friday 17:00 New York time and sits frozen at
 * Friday's close over the weekend. Holidays are not modelled (the server does not
 * either): the weekend is the only long dark window.
 */
const NY = "America/New_York";
const BOUNDARY_MIN = 17 * 60;
/** "FX is back" holds this long after the Sunday reopen. */
export const FX_BACK_MS = 2 * 60 * 60_000;

/** `weekend`: Fri 17:00 to Sun 17:00 New York. `back`: the first two hours after the reopen. */
export type FxMoment = "open" | "weekend" | "back";

function nyParts(ms: number): { weekday: string; minutes: number; seconds: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")), seconds: Number(get("second")) };
}

export function isForexOpen(ms: number): boolean {
  const { weekday, minutes } = nyParts(ms);
  if (weekday === "Sat") return false;
  if (weekday === "Fri" && minutes >= BOUNDARY_MIN) return false;
  return !(weekday === "Sun" && minutes < BOUNDARY_MIN);
}

export function fxMoment(ms: number): FxMoment {
  if (!isForexOpen(ms)) return "weekend";
  const { weekday, minutes, seconds } = nyParts(ms);
  const sinceReopen = ((minutes - BOUNDARY_MIN) * 60 + seconds) * 1000;
  return weekday === "Sun" && sinceReopen >= 0 && sinceReopen < FX_BACK_MS ? "back" : "open";
}

/** The next Sunday 17:00 New York at or after `ms` (the weekend's reopen; New York is on a whole-hour offset, so half-hour steps land on it). */
export function forexReopen(ms: number): number {
  const STEP = 30 * 60_000;
  let t = Math.ceil(ms / STEP) * STEP;
  for (let i = 0; i < 2 * 24 * 3 && !isForexOpen(t); i++) t += STEP;
  return t;
}

/** The FX moment and the instant it was read, re-read every half minute (the boundaries are minute-exact). */
export function useFxMoment(): { moment: FxMoment; at: number } {
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setAt(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return { moment: fxMoment(at), at };
}
