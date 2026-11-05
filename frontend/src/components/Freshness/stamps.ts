/**
 * The one place the app words *when* something happened. Two different facts
 * are kept apart everywhere (as in the v5 web app):
 *
 * - **Price as of**: when the price itself is from, always with what it is:
 *   "today 15:42 (live)", "yesterday 22:00 (close)", "Wed (NAV)". A fund's NAV
 *   is never called a close.
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
  /** Short form (phone top bar): name yesterday by its weekday ("Wed 22:00", not "yesterday 22:00"). */
  weekdays?: boolean;
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
  if (diff === 1 && !opts.weekdays) return `yesterday ${clock}`;
  if (diff === 1) return `${dateWords(day, today, true)} ${clock}`;
  if (diff > 1 && diff < 7) return `${dateWords(day, today, true)} ${clock}`;
  return dateWords(day, today, false);
}

/** Upper-case the first letter ("yesterday 22:00 (close)" -> "Yesterday 22:00 (close)") for a stamp that starts a line. */
export const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The closing bell a "close" refers to: US listings, 16:00 New York. */
export const US_CLOSE = { zone: "America/New_York", hour: 16 } as const;

export interface ClosingBell {
  zone: string;
  hour: number;
}

/** The instant `hour`:00 falls on in `zone` on `iso` ("YYYY-MM-DD"), as an ISO string. */
export function zonedInstant(iso: string, hour: number, zone: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, 0);
  let guess = wanted;
  // Two passes settle the zone's offset on that day (DST included).
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    guess += wanted - Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  }
  return new Date(guess).toISOString();
}

/**
 * A settled close in words: the exact closing time in the viewer's zone plus
 * what it is ("yesterday 22:00 (close)", "Fri 22:00 (close)", "Mon 12 Oct (close)").
 * With no known closing bell (`close: null`), the day alone ("Fri (close)").
 */
export function closeOf(sessionDate: string, opts: StampOptions & { close?: ClosingBell | null } = {}): string {
  const close = opts.close === undefined ? US_CLOSE : opts.close;
  if (relativeDay(sessionDate, opts) === "–") return "–";
  if (close) return `${formatStamp(zonedInstant(sessionDate, close.hour, close.zone), opts)} (close)`;
  return `${relativeDay(sessionDate, opts)} (close)`;
}

/** What a price stamp is built from. */
export interface PriceTime {
  /**
   * The instant the price was struck / observed: a live quote's time, the
   * exchange's market time of a close, or a fund's NAV publish time.
   */
  instant?: string | null;
  /** The session date the price belongs to (a settled close or a NAV's date). */
  date?: string | null;
  /** Whether that price's market is trading right now. */
  marketOpen?: boolean;
  /** "nav": a fund's net asset value (never a market close or a live quote). Default "close". */
  kind?: "close" | "nav";
  /**
   * The closing bell `date` refers to, to place a close that has no instant
   * (default: US listings, 16:00 New York). `null`: unknown, say the day only.
   */
  close?: ClosingBell | null;
}

/** The calendar day an instant falls on in `zone` (the exchange's session date). */
function sessionDay(instant: string, zone: string): string | null {
  const d = parseInstant(instant);
  return Number.isNaN(d.getTime()) ? null : todayIn(zone, d);
}

/**
 * When a price is from, in words, always with what it is:
 *
 * - a live quote while its market trades: "today 15:42 (live)";
 * - a settled close: its exact time in the viewer's zone, "yesterday 22:00 (close)";
 * - a fund's NAV: its publish time when known, "yesterday 23:41 (NAV)", else
 *   its day, "Wed (NAV)". A NAV is never called a close.
 *
 * For a settled price the instant is used only when it is from the same
 * session as `date` (an older market time must not date a newer close).
 */
export function priceAsOf(p: PriceTime, opts: StampOptions = {}): string | null {
  const tz = opts.timeZone ?? getFormatPrefs().timeZone;
  const today = todayIn(tz, opts.now ?? new Date());
  const close = p.close === undefined ? US_CLOSE : p.close;
  const zone = close?.zone ?? US_CLOSE.zone;
  const instant = p.instant && dayOf(p.instant, tz) !== null ? p.instant : null;
  const sameSession = instant !== null && (!p.date || sessionDay(instant, zone) === p.date);
  if (p.kind === "nav") {
    if (instant && sameSession) return `${formatStamp(instant, opts)} (NAV)`;
    if (p.date) return `${relativeDay(p.date, opts)} (NAV)`;
    return null;
  }
  if (instant && p.marketOpen && dayOf(instant, tz) === today) return `${formatStamp(instant, opts)} (live)`;
  if (p.date) {
    // A market time well after the closing bell is not the close (an after-hours
    // print, or a fund's NAV mixed into a portfolio-wide time): say the bell.
    const lateMs = close ? parseInstant(zonedInstant(p.date, close.hour, close.zone)).getTime() + 30 * 60_000 : Infinity;
    if (instant && sameSession && parseInstant(instant).getTime() <= lateMs) return `${formatStamp(instant, opts)} (close)`;
    return closeOf(p.date, { ...opts, close });
  }
  if (instant) return formatStamp(instant, opts);
  return null;
}

/** The facts of a holdings row a price stamp needs (see `HoldingRow` in the API). */
export interface HoldingTimeRow {
  updated_at?: string | null;
  price_as_of?: string | null;
  price_market_at?: string | null;
  market_open: boolean;
  daily_is_stale: boolean;
  price_type?: string;
  asset_class?: string;
  native_currency?: string;
}

/** Asset classes priced once a day at their NAV (mirrors `NAV_ASSET_CLASSES` on the server). */
export const NAV_ASSET_CLASSES: ReadonlySet<string> = new Set(["mutual_fund"]);

/** True for a fund priced at its NAV (never a "close"). */
export const isNavRow = (row: Pick<HoldingTimeRow, "price_type" | "asset_class">): boolean =>
  row.price_type === "nav" || NAV_ASSET_CLASSES.has(row.asset_class ?? "");

/**
 * A holding row's price time: a live quote while its market trades (its
 * market time, else when it was fetched); otherwise the close (or NAV) of
 * `price_as_of`, at the provider's market time when that is from the same session.
 */
export function holdingPriceTime(row: HoldingTimeRow): PriceTime {
  const nav = isNavRow(row);
  const live = !nav && row.market_open && !row.daily_is_stale;
  const ccy = (row.native_currency ?? "USD").toUpperCase();
  return {
    instant: row.price_market_at ?? (live || !row.price_as_of ? (row.updated_at ?? null) : null),
    date: row.price_as_of ?? null,
    marketOpen: live,
    kind: nav ? "nav" : "close",
    close: ccy === "USD" ? US_CLOSE : null,
  };
}

/** One list's stamps said once: the common price time, the latest fetch, and which rows differ. */
export interface FoldedStamps<T> {
  /** The price time most rows share ("yesterday 22:00 (close)"), or null. */
  price: string | null;
  /** The newest fetch time of any row (a server instant). */
  updated: string | null;
  /** A row's own price time, only when it differs from `price` (else null: nothing to show on the row). */
  rowPrice: (row: T) => string | null;
}

/**
 * Says a list's price time once (in the card / table header) and shows a row's
 * own stamp only when it differs from the rest (a stale price, a fund's NAV, a
 * close from another session). The common stamp is the one most rows share;
 * a tie goes to the earlier row (lists are largest first).
 */
export function foldStamps<T extends HoldingTimeRow>(rows: T[], opts: StampOptions = {}): FoldedStamps<T> {
  const texts = new Map<T, string | null>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const t = priceAsOf(holdingPriceTime(r), opts);
    texts.set(r, t);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let price: string | null = null;
  let best = 0;
  for (const [t, n] of counts) {
    if (n > best) {
      price = t;
      best = n;
    }
  }
  let updated: string | null = null;
  let updatedMs = -Infinity;
  for (const r of rows) {
    if (!r.updated_at) continue;
    const ms = parseInstant(r.updated_at).getTime();
    if (ms > updatedMs) {
      updated = r.updated_at;
      updatedMs = ms;
    }
  }
  return {
    price,
    updated,
    rowPrice: (row) => {
      const t = texts.has(row) ? (texts.get(row) ?? null) : priceAsOf(holdingPriceTime(row), opts);
      return t && t !== price ? t : null;
    },
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

/** The row facts the per-holding freshness marks need. */
export interface MarkRow extends HoldingTimeRow {
  is_money_market?: boolean;
  daily_growth_as_of?: string | null;
}

/** Per-holding freshness marks for one list (v5 web parity): the stale-move note and the up-to-date tick. */
export interface HoldingMarks<T> {
  /** "Not updated yesterday — an earlier session's move" for a row whose day move is an older session's, else null. */
  staleMove: (row: T) => string | null;
  /**
   * The ✓ beside a row's price, only while its market is closed and the row
   * already holds the latest settled close (or NAV): "Up to date with the
   * latest close". Never for money-market funds (par, never fetched). Else null.
   */
  tick: (row: T) => string | null;
}

/**
 * The two per-row freshness marks of one list. "Latest" is the newest price
 * date among the list's priced rows (the session its peers are on), and the
 * session word is the newest day-move date's ("yesterday", "Wed").
 */
export function holdingMarks<T extends MarkRow>(rows: T[], opts: StampOptions = {}): HoldingMarks<T> {
  let latestPrice: string | null = null;
  let latestMove: string | null = null;
  for (const r of rows) {
    if (!r.is_money_market && r.price_as_of && (!latestPrice || r.price_as_of > latestPrice)) latestPrice = r.price_as_of;
    if (r.daily_growth_as_of && (!latestMove || r.daily_growth_as_of > latestMove)) latestMove = r.daily_growth_as_of;
  }
  const word = latestMove ? relativeDay(latestMove, opts) : "today";
  return {
    staleMove: (row) => (row.daily_is_stale ? `Not updated ${word} — an earlier session's move` : null),
    tick: (row) => {
      if (row.is_money_market || row.market_open || row.daily_is_stale) return null;
      if (!row.price_as_of || !latestPrice || row.price_as_of < latestPrice) return null;
      return `Up to date with the latest ${isNavRow(row) ? "NAV" : "close"}`;
    },
  };
}
