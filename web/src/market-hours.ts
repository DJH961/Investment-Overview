/**
 * Lightweight US-equity market-clock helper — the browser companion's mirror of
 * the desktop `domain/market_hours.py`, extended with a NYSE holiday calendar.
 *
 * The overview wants to tell two situations apart for its Daily Growth caption,
 * and the "live" badges want to be honest about whether a figure is genuinely
 * live:
 *   - the **regular session is open right now** — prices/FX move intraday, so we
 *     show a live, time-stamped figure ("as of 3:42 PM"); and
 *   - the **session is closed** — the most recent print is a settled close, so
 *     we pin to that date instead ("as of Fri 20 Jun").
 *
 * This models the NYSE *regular* weekday session, 09:30–16:00
 * America/New_York, **and** the full-day market holidays (New Year's Day, MLK
 * Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth,
 * Independence Day, Labor Day, Thanksgiving, Christmas, each with the
 * Saturday→Friday / Sunday→Monday observed-day rule). On a holiday the session
 * is reported **closed**, so a stale carried-forward close is never dressed up
 * as a live, time-stamped figure. Half-day early closes (1:00pm on a few
 * sessions) are deliberately not modelled — the worst case there is showing the
 * settled wording a few hours early for numbers that are identical either way.
 */

const MARKET_TZ = "America/New_York";
const OPEN_MINUTES = 9 * 60 + 30; // 09:30
const CLOSE_MINUTES = 16 * 60; // 16:00

interface ExchangeMoment {
  /** Weekday 0–6 (Sun–Sat) in the exchange timezone. */
  weekday: number;
  /** Minutes since midnight in the exchange timezone. */
  minutes: number;
  /** Calendar year in the exchange timezone. */
  year: number;
  /** Calendar month 1–12 in the exchange timezone. */
  month: number;
  /** Calendar day-of-month 1–31 in the exchange timezone. */
  day: number;
}

/** The exchange-local wall clock + calendar date for an instant. */
function exchangeMoment(now: Date): ExchangeMoment {
  // `en-US` with an explicit timeZone yields the New York wall-clock parts
  // regardless of the device's own timezone — the browser equivalent of the
  // desktop's `astimezone(America/New_York)`.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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
  return {
    weekday,
    minutes: hour * 60 + minute,
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
  };
}

/** Day-of-week 0–6 (Sun–Sat) for a Gregorian Y-M-D, timezone-independent. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The observed weekday for a fixed-date holiday: a Saturday holiday is observed
 * the preceding Friday, a Sunday holiday the following Monday — the NYSE rule.
 * Returns the `[month, day]` the market is actually closed.
 */
function observed(year: number, month: number, day: number): [number, number] {
  const wd = weekdayOf(year, month, day);
  if (wd === 6) {
    // Saturday → observed Friday (the day before).
    const d = new Date(Date.UTC(year, month - 1, day - 1));
    return [d.getUTCMonth() + 1, d.getUTCDate()];
  }
  if (wd === 0) {
    // Sunday → observed Monday (the day after).
    const d = new Date(Date.UTC(year, month - 1, day + 1));
    return [d.getUTCMonth() + 1, d.getUTCDate()];
  }
  return [month, day];
}

/** The `[month, day]` of the `nth` `weekday` (0–6) of `month` in `year`. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): [number, number] {
  const firstWd = weekdayOf(year, month, 1);
  const offset = (weekday - firstWd + 7) % 7;
  return [month, 1 + offset + (nth - 1) * 7];
}

/** The `[month, day]` of the last `weekday` (0–6) of `month` in `year`. */
function lastWeekday(year: number, month: number, weekday: number): [number, number] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastWd = weekdayOf(year, month, daysInMonth);
  const offset = (lastWd - weekday + 7) % 7;
  return [month, daysInMonth - offset];
}

/** Easter Sunday `[month, day]` for `year` (anonymous Gregorian algorithm). */
function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** Good Friday `[month, day]` — two days before Easter Sunday. */
function goodFriday(year: number): [number, number] {
  const [em, ed] = easterSunday(year);
  const d = new Date(Date.UTC(year, em - 1, ed - 2));
  return [d.getUTCMonth() + 1, d.getUTCDate()];
}

/** Cache of computed `MM-DD` holiday sets, keyed by year. */
const holidayCache = new Map<number, Set<string>>();

function key(month: number, day: number): string {
  return `${month}-${day}`;
}

/** The set of `MM-DD` NYSE full-day market holidays observed in `year`. */
function holidaysForYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const set = new Set<string>();
  const add = (md: [number, number]): void => {
    set.add(key(md[0], md[1]));
  };
  add(observed(year, 1, 1)); // New Year's Day
  add(nthWeekday(year, 1, 1, 3)); // MLK Day — 3rd Monday of January
  add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday — 3rd Monday of February
  add(goodFriday(year)); // Good Friday
  add(lastWeekday(year, 5, 1)); // Memorial Day — last Monday of May
  if (year >= 2022) add(observed(year, 6, 19)); // Juneteenth (NYSE from 2022)
  add(observed(year, 7, 4)); // Independence Day
  add(nthWeekday(year, 9, 1, 1)); // Labor Day — 1st Monday of September
  add(nthWeekday(year, 11, 4, 4)); // Thanksgiving — 4th Thursday of November
  add(observed(year, 12, 25)); // Christmas Day
  holidayCache.set(year, set);
  return set;
}

/**
 * Whether `now` falls on a full-day NYSE market holiday, evaluated against the
 * exchange-local (New York) calendar date so it is correct regardless of the
 * viewer's own timezone. Half-day early closes are not treated as holidays.
 */
export function isUsMarketHoliday(now: Date = new Date()): boolean {
  const { year, month, day } = exchangeMoment(now);
  return holidaysForYear(year).has(key(month, day));
}

/**
 * Whether the NYSE regular session is open at `now` (defaults to the current
 * instant). Weekends and full-day market holidays are always closed; otherwise
 * the regular 09:30–16:00 America/New_York window applies.
 */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  const moment = exchangeMoment(now);
  if (moment.weekday === 0 || moment.weekday === 6) return false; // Sun / Sat
  if (holidaysForYear(moment.year).has(key(moment.month, moment.day))) return false;
  return moment.minutes >= OPEN_MINUTES && moment.minutes < CLOSE_MINUTES;
}
