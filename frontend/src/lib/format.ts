/** Display-only formatting via Intl. No business maths. */

export type Currency = string;

const LOCALE = "en-GB";

export interface MoneyOptions {
  signed?: boolean;
  compact?: boolean;
  /** Override fraction digits (default 2, 1 when compact). */
  digits?: number;
}

const isMissing = (v: number | null | undefined): v is null | undefined =>
  v === null || v === undefined || Number.isNaN(v);

export function formatMoney(amount: number | null | undefined, currency: Currency, opts: MoneyOptions = {}): string {
  if (isMissing(amount)) return "–";
  const digits = opts.digits ?? (opts.compact ? 1 : 2);
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    notation: opts.compact ? "compact" : "standard",
    minimumFractionDigits: opts.compact ? 0 : digits,
    maximumFractionDigits: digits,
    signDisplay: opts.signed ? "exceptZero" : "auto",
  }).format(amount);
}

/** `ratio` is a fraction: 0.0525 -> "5.25%". */
export function formatPercent(
  ratio: number | null | undefined,
  opts: { signed?: boolean; digits?: number } = {},
): string {
  if (isMissing(ratio)) return "–";
  const digits = opts.digits ?? 2;
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: opts.signed ? "exceptZero" : "auto",
  }).format(ratio);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (isMissing(value)) return "–";
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatDate(value: string | Date, style: "short" | "medium" | "long" = "medium"): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: style, timeZone: "UTC" }).format(d);
}

export function formatTime(value: string | Date, timeZone?: string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", timeZone }).format(d);
}

/** Sign class helper: gains / losses / flat. */
export function signOf(value: number | null | undefined): "pos" | "neg" | "flat" {
  if (!value) return "flat";
  return value > 0 ? "pos" : "neg";
}

function validDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Fri 22:00" in `timeZone` (default: the browser's). */
export function formatWeekdayTime(value: string | number | Date, timeZone?: string): string {
  const d = validDate(value);
  if (!d) return "–";
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { ...o, timeZone }).format(d);
  return `${fmt({ weekday: "short" })} ${fmt({ hour: "2-digit", minute: "2-digit" })}`;
}

/** "Mon 26 Oct 14:30" in `timeZone`. */
export function formatDayTime(value: string | number | Date, timeZone?: string): string {
  const d = validDate(value);
  if (!d) return "–";
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { ...o, timeZone }).format(d);
  return `${fmt({ weekday: "short" })} ${fmt({ day: "numeric", month: "short" })} ${fmt({ hour: "2-digit", minute: "2-digit" })}`;
}

/** A calendar date (ISO "2026-10-30") as "Fri 30 Oct"; `weekday: "long"` gives just "Friday". */
export function formatDayLabel(value: string, style: "short" | "weekday" = "short"): string {
  const d = validDate(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!d) return "–";
  if (style === "weekday") return new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" }).format(d);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { ...o, timeZone: "UTC" }).format(d);
  return `${fmt({ weekday: "short" })} ${fmt({ day: "numeric", month: "short" })}`;
}

/** Today's calendar date (ISO) in `timeZone`. */
export function todayIn(timeZone?: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "Mon 26" in `timeZone` (1W axis labels). */
export function formatShortDay(value: string | number | Date, timeZone?: string): string {
  const d = validDate(value);
  if (!d) return "–";
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { ...o, timeZone }).format(d);
  return `${fmt({ weekday: "short" })} ${fmt({ day: "numeric" })}`;
}

/**
 * The one place charts format money (axis ticks, tooltips, reference labels).
 * Keep every chart going through this so a later "hide numbers" / "% from
 * start" mode can swap the formatter in one spot.
 */
export function chartMoneyFormat(currency: Currency, kind: "axis" | "tooltip" = "tooltip"): (v: number) => string {
  return kind === "axis"
    ? (v) => formatMoney(v, currency, { digits: 0, compact: Math.abs(v) >= 1_000_000 })
    : (v) => formatMoney(v, currency, { digits: 0 });
}
