/**
 * The one place the app words *when* something happened. Two different facts
 * are kept apart everywhere (as in the v5 web app):
 *
 * - **Price as of**: when the price itself is from (the exchange print or the
 *   session close it belongs to): "Price as of today 15:42", "yesterday's close".
 * - **Updated**: when this app last fetched it: "Updated today 15:47".
 *
 * Dates are summarised relative to the viewer's day in the Settings timezone:
 * "today 15:42", "yesterday 09:10", "Mon 15:42" (this week), else "Mon 2 Nov"
 * (plus the year when it is not this year).
 */
import { formatTime, getFormatPrefs, parseInstant, todayIn } from "../../lib/format";

export interface StampOptions {
  /** IANA zone (default: the Settings zone). */
  timeZone?: string;
  /** Injected clock for tests. */
  now?: Date;
}

type Input = string | number | Date;

const isCalendarDate = (v: Input): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Whole days from `iso` to `today` (both "YYYY-MM-DD"); positive = in the past. */
function dayDiff(iso: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
}

/** The calendar day ("YYYY-MM-DD") an input falls on in `timeZone` (a calendar date is itself). */
function dayOf(value: Input, timeZone: string | undefined): string | null {
  if (isCalendarDate(value)) return value;
  const d = parseInstant(value);
  if (Number.isNaN(d.getTime())) return null;
  return todayIn(timeZone, d);
}

function dateWords(iso: string, today: string, weekdayOnly: boolean): string {
  const { locale } = getFormatPrefs();
  const d = new Date(`${iso}T12:00:00Z`);
  if (weekdayOnly) return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(d);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  })
    .format(d)
    .replace(/,(?=\s\d{4}$)/, "");
}

/**
 * "today" / "yesterday" / "Mon" (within the last week) / "Mon 2 Nov" for the
 * day `value` falls on. Future days read as their date.
 */
export function relativeDay(value: Input, opts: StampOptions = {}): string {
  const tz = opts.timeZone ?? getFormatPrefs().timeZone;
  const day = dayOf(value, tz);
  if (!day) return "–";
  const today = todayIn(tz, opts.now ?? new Date());
  const diff = dayDiff(day, today);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  return dateWords(day, today, diff > 1 && diff < 7);
}

/**
 * A moment as the app says it: "today 15:42", "yesterday 15:42", "Mon 15:42"
 * (this week), "Mon 2 Nov" (older; the clock is dropped). A calendar date
 * ("2026-11-02") has no clock: "today", "yesterday", "Mon 2 Nov".
 */
export function formatStamp(value: Input | null | undefined, opts: StampOptions = {}): string {
  if (value === null || value === undefined || value === "") return "–";
  const tz = opts.timeZone ?? getFormatPrefs().timeZone;
  const day = dayOf(value, tz);
  if (!day) return "–";
  const today = todayIn(tz, opts.now ?? new Date());
  const diff = dayDiff(day, today);
  if (isCalendarDate(value)) {
    if (diff === 0) return "today";
    if (diff === 1) return "yesterday";
    return dateWords(day, today, false);
  }
  const clock = formatTime(parseInstant(value), tz);
  if (diff === 0) return `today ${clock}`;
  if (diff === 1) return `yesterday ${clock}`;
  if (diff > 1 && diff < 7) return `${dateWords(day, today, true)} ${clock}`;
  return dateWords(day, today, false);
}

/** "today's close" / "yesterday's close" / "Mon 2 Nov close" for a session date. */
export function closeOf(sessionDate: string, opts: StampOptions = {}): string {
  const day = relativeDay(sessionDate, opts);
  if (day === "today" || day === "yesterday") return `${day}'s close`;
  if (day === "–") return "–";
  // A weekday on its own is ambiguous for a close: always name the date.
  const tz = opts.timeZone ?? getFormatPrefs().timeZone;
  return `${dateWords(sessionDate, todayIn(tz, opts.now ?? new Date()), false)} close`;
}

/** What a price stamp is built from. */
export interface PriceTime {
  /** The instant the price was struck / observed (live quotes, NAV publish time). */
  instant?: string | null;
  /** The session date the price belongs to (a settled close). */
  date?: string | null;
  /** Whether that price's market is trading right now. */
  marketOpen?: boolean;
}

/**
 * When a price is from, in words. While its market trades and the instant is
 * from today, the clock time ("today 15:42"); otherwise the close it belongs
 * to ("yesterday's close"), falling back to the instant ("Mon 22:00").
 */
export function priceAsOf(p: PriceTime, opts: StampOptions = {}): string | null {
  const tz = opts.timeZone ?? getFormatPrefs().timeZone;
  const today = todayIn(tz, opts.now ?? new Date());
  const instantDay = p.instant ? dayOf(p.instant, tz) : null;
  if (p.instant && p.marketOpen && instantDay === today) return formatStamp(p.instant, opts);
  if (p.date) return closeOf(p.date, opts);
  if (p.instant) return formatStamp(p.instant, opts);
  return null;
}

/**
 * A holding row's price time: a live quote is from when it was fetched
 * (`updated_at`) while its market trades; otherwise it is the close of
 * `price_as_of`.
 */
export function holdingPriceTime(row: {
  updated_at?: string | null;
  price_as_of?: string | null;
  market_open: boolean;
  daily_is_stale: boolean;
}): PriceTime {
  return {
    instant: row.updated_at ?? null,
    date: row.price_as_of ?? null,
    marketOpen: row.market_open && !row.daily_is_stale,
  };
}

/** "Last session · Tue" for a day move that is not today's, else null. */
export function lastSessionLabel(sessionDate: string | null | undefined, opts: StampOptions = {}): string | null {
  if (!sessionDate) return null;
  const day = relativeDay(sessionDate, opts);
  if (day === "today" || day === "–") return null;
  const { locale } = getFormatPrefs();
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${sessionDate}T12:00:00Z`),
  );
  return `Last session · ${weekday}`;
}
