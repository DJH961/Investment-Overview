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

/**
 * How recently the freshest price must have been observed for the headline total
 * to be called *live* (rather than merely a same-day settled figure) while the
 * session is open. The auto-refresh runs on a ~1–5 min cadence, so a 15-minute
 * ceiling keeps a normal between-refreshes gap (or a brief provider hiccup) from
 * flickering "Live" off, while a genuinely stalled or unreachable feed — no
 * fresh price for many minutes — correctly stops claiming to be live. Mirrors
 * the desktop's `LIVE_PRICE_WINDOW_SECONDS` (900 s).
 */
export const LIVE_PRICE_MAX_STALENESS_MS = 15 * 60 * 1000;

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

/** Whether `[year, month, day]` (NY calendar) is a regular NYSE trading day. */
function isTradingDay(year: number, month: number, day: number): boolean {
  const wd = weekdayOf(year, month, day);
  if (wd === 0 || wd === 6) return false; // Sun / Sat
  return !holidaysForYear(year).has(key(month, day));
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${`${month}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`;
}

/**
 * The trading day (`YYYY-MM-DD`, New-York calendar) of the most recent NYSE
 * regular session whose close has **already happened** as of `now`.
 *
 * Today counts only once its 16:00 close has passed on a trading day; before the
 * open, mid-session, on weekends, and on holidays this is the previous trading
 * day. Used by the refresh layer to tell whether the cached close we already
 * hold is the latest one there is, so it can stop polling a market symbol while
 * the exchange is shut instead of re-fetching an unchanged close.
 */
export function latestSettledSessionDate(now: Date = new Date()): string {
  const moment = exchangeMoment(now);
  if (isTradingDay(moment.year, moment.month, moment.day) && moment.minutes >= CLOSE_MINUTES) {
    return ymd(moment.year, moment.month, moment.day);
  }
  // Walk back to the previous trading day (UTC stepping keeps the calendar math
  // timezone-independent; only the date components matter here).
  let date = new Date(Date.UTC(moment.year, moment.month - 1, moment.day));
  do {
    date = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  } while (!isTradingDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Trading day (`YYYY-MM-DD`, New-York calendar) of the most recent NYSE session
 * that has **started** as of `now` — the session the live "1 Day" curve covers.
 *
 * "Started" (not "settled") is the distinction from {@link latestSettledSessionDate}:
 * today becomes the current session the moment its 09:30 open passes on a trading
 * day, and stays the current session right through the 16:00 close and overnight
 * until the *next* session opens. Before today's open, on weekends, and on
 * holidays this is the previous trading day, so a Saturday still shows Friday's
 * full session (mirrors the desktop `last_session_date`).
 */
export function lastSessionDate(now: Date = new Date()): string {
  const moment = exchangeMoment(now);
  if (isTradingDay(moment.year, moment.month, moment.day) && moment.minutes >= OPEN_MINUTES) {
    return ymd(moment.year, moment.month, moment.day);
  }
  return previousTradingSession(ymd(moment.year, moment.month, moment.day));
}

/**
 * The most recent regular NYSE trading day **strictly before** `day`
 * (`YYYY-MM-DD`, New-York calendar). Skips weekends and full-day holidays, so it
 * marks the genuine previous *session* even across a long weekend (mirrors the
 * desktop `previous_trading_session`).
 */
export function previousTradingSession(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  let date = new Date(Date.UTC(year, month - 1, dayOfMonth));
  do {
    date = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  } while (!isTradingDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * The `count` most recent NYSE trading sessions up to and including the current
 * session as of `now`, **ascending** (`YYYY-MM-DD`, New-York calendar) — the
 * window the live "1 Week" curve spans. The newest entry is {@link lastSessionDate}
 * (so a weekend window still ends on Friday's session), and each earlier entry is
 * the {@link previousTradingSession} of the one after it, skipping weekends and
 * holidays. `count <= 0` yields an empty list.
 */
export function recentTradingSessions(count: number, now: Date = new Date()): string[] {
  if (count <= 0) return [];
  const days: string[] = [lastSessionDate(now)];
  for (let i = 1; i < count; i += 1) {
    days.push(previousTradingSession(days[days.length - 1]));
  }
  return days.reverse();
}

/**
 * Minutes to add to a UTC instant to reach the exchange-local (New York) wall
 * clock — i.e. `ET = UTC + offset`. Negative (−240 EDT / −300 EST). Used to turn
 * an exchange wall-clock time on a given day into an absolute UTC instant.
 */
function etOffsetMinutes(date: Date): number {
  const moment = exchangeMoment(date);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  let diff = moment.minutes - utcMinutes;
  // The wall clocks can straddle a UTC-day boundary; fold into ±12h.
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

/**
 * Absolute UTC epoch-ms of the exchange-local wall-clock `wallMinutes`
 * (minutes since New-York midnight) on `day` (`YYYY-MM-DD`). Resolved by
 * correcting a UTC guess by the exchange offset in force on that day (two passes
 * settle any DST edge). The offset is looked up from the instant itself, so it
 * is correct on either side of a daylight-saving change.
 */
function exchangeWallToUtcMs(day: string, wallMinutes: number): number {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const midnightUtc = Date.UTC(year, month - 1, dayOfMonth);
  let utc = midnightUtc + wallMinutes * 60_000;
  for (let i = 0; i < 2; i += 1) {
    const offset = etOffsetMinutes(new Date(utc));
    utc = midnightUtc + (wallMinutes - offset) * 60_000;
  }
  return utc;
}

/**
 * Absolute UTC epoch-ms of the 16:00 ET regular-session close on `day`
 * (`YYYY-MM-DD`, New-York calendar). The live "1 Day" curve is pinned here once
 * the session has shut, so it ends at the close rather than trailing a flat line
 * out to the current wall-clock time, and a weekend still bounds Friday's
 * session at Friday 16:00 (mirrors the desktop `session_close_utc`).
 */
export function sessionCloseMs(day: string): number {
  return exchangeWallToUtcMs(day, CLOSE_MINUTES);
}

/**
 * Absolute UTC epoch-ms of the 09:30 ET regular-session open on `day`
 * (`YYYY-MM-DD`, New-York calendar) — the lower bound of the "1 Day" window.
 */
export function sessionOpenMs(day: string): number {
  return exchangeWallToUtcMs(day, OPEN_MINUTES);
}

/**
 * The intraday 1D curve is built from one-hour resampled bars (Tiingo IEX
 * `resampleFreq=1hour`, Twelve Data falls back to a coarser series), so no
 * completed intraday bar can exist until a full bar interval of trading time has
 * elapsed since the open. Used to tell an *expected-empty* fresh session apart
 * from a genuinely *stale* one (market_open_token_burn_fix_plan.md WS1).
 */
export const INTRADAY_BAR_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Trading time (ms) elapsed since the open of the current 1D session as of `now`.
 *
 * For a session that has already started today this is small right after 09:30
 * and grows through the day; for any *past* session (before today's open, on a
 * weekend, or overnight after the close) it is at least a full day, because the
 * open being measured is that earlier session's 09:30. Never negative:
 * {@link lastSessionDate} only advances to today once its open has passed.
 */
export function elapsedSessionMs(now: Date = new Date()): number {
  const open = sessionOpenMs(lastSessionDate(now));
  return Math.max(0, now.getTime() - open);
}

/**
 * Whether the current 1D session is still *warming up* — open, but with less than
 * one intraday bar interval of trading time elapsed, so no completed intraday bar
 * can exist yet. At the open this is true, so the absence of today's bars is
 * **expected**, not stale: no 1D backfill is queued for a window that has not
 * happened, and the curve accrues tick-by-tick from the live tip instead
 * (market_open_token_burn_fix_plan.md WS1). Any past session reads `false`
 * (its elapsed time is ≥ a day), so its genuinely-missing bars still backfill.
 */
export function sessionIsWarmingUp(now: Date = new Date()): boolean {
  return elapsedSessionMs(now) < INTRADAY_BAR_INTERVAL_MS;
}
