/**
 * Lightweight US-equity market-clock helper — the browser companion's mirror of
 * the desktop `domain/market_hours.py`.
 *
 * The overview wants to tell two situations apart for its Daily Growth caption:
 *   - the **regular session is open right now** — prices/FX move intraday, so we
 *     show a live, time-stamped figure ("as of 3:42 PM"); and
 *   - the **session is closed** — the most recent print is a settled close, so
 *     we pin to that date instead ("as of Fri 20 Jun").
 *
 * Like the desktop helper this models only the NYSE *regular* weekday session,
 * 09:30–16:00 America/New_York, and intentionally does NOT know about market
 * holidays or half-days (on those it may report "open", which at worst shows the
 * live rather than settled wording for numbers that are identical either way).
 * Keeping it dependency-free and pure is worth that small imprecision.
 */

const MARKET_TZ = "America/New_York";
const OPEN_MINUTES = 9 * 60 + 30; // 09:30
const CLOSE_MINUTES = 16 * 60; // 16:00

/** The exchange-local wall clock (weekday 0–6, minutes since midnight) for an instant. */
function exchangeClock(now: Date): { weekday: number; minutes: number } {
  // `en-US` with an explicit timeZone yields the New York wall-clock parts
  // regardless of the device's own timezone — the browser equivalent of the
  // desktop's `astimezone(America/New_York)`.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdays[get("weekday")] ?? 0;
  // `hour12: false` can render midnight as "24"; normalise it to 0.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { weekday, minutes: hour * 60 + minute };
}

/**
 * Whether the NYSE regular session is open at `now` (defaults to the current
 * instant). Weekends are always closed; holidays are not modelled.
 */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  const { weekday, minutes } = exchangeClock(now);
  if (weekday === 0 || weekday === 6) return false; // Sun / Sat
  return minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES;
}
