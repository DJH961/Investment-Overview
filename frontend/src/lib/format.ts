/** Display-only formatting via Intl. No business maths. */

export type Currency = string;

/** Supported number/date locales (Settings → Display; `display.locale`). */
export type Locale = "en-GB" | "de-DE" | "en-US";

export interface FormatPrefs {
  locale: Locale;
  /** IANA zone for date-times; `undefined` = the browser's own zone. */
  timeZone: string | undefined;
  /** `true` 12-hour, `false` 24-hour, `undefined` = the locale's default. */
  hour12: boolean | undefined;
}

// Module-level so plain functions (no hooks) format with the user's prefs.
// `lib/displayPrefs.tsx` feeds these from the server settings (+ local cache).
let LOCALE: Locale = "en-GB";
let TIME_ZONE: string | undefined;
let HOUR12: boolean | undefined;

/** Called by `lib/displayPrefs.tsx`; tests may call it directly. */
export function setFormatPrefs(prefs: Partial<FormatPrefs>): void {
  if (prefs.locale) LOCALE = prefs.locale;
  if ("timeZone" in prefs) TIME_ZONE = prefs.timeZone;
  if ("hour12" in prefs) HOUR12 = prefs.hour12;
}

export function getFormatPrefs(): FormatPrefs {
  return { locale: LOCALE, timeZone: TIME_ZONE, hour12: HOUR12 };
}

// Per-device "Hide numbers" mode: absolute amounts and quantities render as a mask.
let HIDE_AMOUNTS = false;

/** Mask shown in place of a hidden figure. */
export const MASK = "•••••";

/** Called by `lib/hideAmounts.tsx`; tests may call it directly. */
export function setHideAmounts(on: boolean): void {
  HIDE_AMOUNTS = on;
}

export function isHidingAmounts(): boolean {
  return HIDE_AMOUNTS;
}

export interface MoneyOptions {
  signed?: boolean;
  compact?: boolean;
  /** Override fraction digits (default 2, 1 when compact). */
  digits?: number;
  /** Public market data (a unit price): never masked in hide mode. */
  unmasked?: boolean;
  /** "$" instead of "US$" (charts, where the EUR/USD pair makes it unambiguous). */
  narrow?: boolean;
  /** Significant digits instead of fraction digits (short axis labels: "$120k", "$96.3k"). */
  significant?: number;
}

const isMissing = (v: number | null | undefined): v is null | undefined =>
  v === null || v === undefined || Number.isNaN(v);

/**
 * Hide mode: the shape of a typical amount ("€••,•••.••", "+US$••,•••.••",
 * "€••.•k"), so hidden figures sit and wrap exactly like real ones. The shape
 * is fixed (a five-digit amount), so it never reveals the real magnitude; the
 * sign is kept because colour already shows it.
 */
function maskedMoney(amount: number, currency: Currency, opts: MoneyOptions): string {
  const digits = opts.digits ?? (opts.compact ? 1 : 2);
  const sample = (opts.compact ? 88_800 : 88_888.88) * (amount < 0 ? -1 : 1);
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    currencyDisplay: opts.narrow ? "narrowSymbol" : "symbol",
    notation: opts.compact ? "compact" : "standard",
    minimumFractionDigits: opts.compact ? 0 : digits,
    maximumFractionDigits: digits,
    // A real zero has no sign; the sample is never zero, so decide here.
    signDisplay: opts.signed && amount !== 0 ? "exceptZero" : "auto",
  })
    .format(sample)
    .replace(/\d/g, "•");
}

export function formatMoney(amount: number | null | undefined, currency: Currency, opts: MoneyOptions = {}): string {
  if (isMissing(amount)) return "–";
  if (HIDE_AMOUNTS && !opts.unmasked) return maskedMoney(amount, currency, opts);
  const digits = opts.digits ?? (opts.compact ? 1 : 2);
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    currencyDisplay: opts.narrow ? "narrowSymbol" : "symbol",
    notation: opts.compact ? "compact" : "standard",
    ...(opts.significant
      ? { maximumSignificantDigits: opts.significant }
      : { minimumFractionDigits: opts.compact ? 0 : digits, maximumFractionDigits: digits }),
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

/** A share count / quantity: masked in hide mode (it reveals value next to public prices). */
export function formatQuantity(value: number | null | undefined, digits = 2): string {
  if (isMissing(value)) return "–";
  return HIDE_AMOUNTS ? MASK : formatNumber(value, digits);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (isMissing(value)) return "–";
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

const isCalendarDate = (value: string | Date): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const clock = (): Intl.DateTimeFormatOptions => (HOUR12 === undefined ? {} : { hour12: HOUR12 });

/**
 * A calendar date ("2026-03-05") is shown as that day everywhere (UTC); a
 * timestamp is shown in the user's timezone (`timeZone` overrides it).
 */
export function formatDate(
  value: string | Date,
  style: "short" | "medium" | "long" = "medium",
  timeZone?: string,
): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "–";
  const zone = isCalendarDate(value) ? "UTC" : (timeZone ?? TIME_ZONE);
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: style, timeZone: zone }).format(d);
}

export function formatTime(value: string | Date, timeZone?: string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone ?? TIME_ZONE,
    ...clock(),
  }).format(d);
}

/**
 * Short chart-axis date: "5 Oct" when the axis spans under a year, "Oct 2026"
 * beyond that (a full date per tick does not fit on a phone).
 */
export function formatAxisDate(t: number, spanMs: number, timeZone?: string): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "–";
  const long = spanMs > 330 * 86_400_000;
  return new Intl.DateTimeFormat(LOCALE, {
    ...(long ? { month: "short", year: "numeric" } : { day: "numeric", month: "short" }),
    timeZone: timeZone ?? "UTC",
  }).format(d);
}

/** "5 Mar 2026, 14:30" in the user's timezone; "never" for a missing stamp. */
export function formatDateTime(value: string | Date | null | undefined, missing = "never"): string {
  if (value === null || value === undefined || value === "") return missing;
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "–";
  return `${formatDate(d)} ${formatTime(d)}`;
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
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(LOCALE, { ...o, ...clock(), timeZone: timeZone ?? TIME_ZONE }).format(d);
  return `${fmt({ weekday: "short" })} ${fmt({ hour: "2-digit", minute: "2-digit" })}`;
}

/** "Mon 26 Oct 14:30" in `timeZone`. */
export function formatDayTime(value: string | number | Date, timeZone?: string): string {
  const d = validDate(value);
  if (!d) return "–";
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(LOCALE, { ...o, ...clock(), timeZone: timeZone ?? TIME_ZONE }).format(d);
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
  return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "Mon 26" in `timeZone` (1W axis labels). */
export function formatShortDay(value: string | number | Date, timeZone?: string): string {
  const d = validDate(value);
  if (!d) return "–";
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(LOCALE, { ...o, ...clock(), timeZone: timeZone ?? TIME_ZONE }).format(d);
  return `${fmt({ weekday: "short" })} ${fmt({ day: "numeric" })}`;
}

/**
 * The one place charts format money (axis ticks, tooltips, reference labels).
 * Keep every chart going through this; formatMoney masks in hide mode, and
 * value charts plot "% from range start" instead (see ValueChartCard).
 */
export function chartMoneyFormat(currency: Currency, kind: "axis" | "tooltip" = "tooltip"): (v: number) => string {
  return kind === "axis"
    ? (v) =>
        Math.abs(v) >= 10_000
          ? formatMoney(v, currency, { compact: true, narrow: true, significant: 3 })
          : formatMoney(v, currency, { digits: 0, narrow: true })
    : (v) => formatMoney(v, currency, { digits: 0, narrow: true });
}

/** A difference of two returns (fraction, 0.0123 = 1.23 pp) as "+1.23 pp". */
export function formatPp(ratio: number | null | undefined, digits = 2): string {
  if (isMissing(ratio)) return "–";
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: "exceptZero",
  }).format(ratio * 100)} pp`;
}

const ASSET_CLASS_LABELS: Record<string, string> = {
  etf: "ETFs",
  mutual_fund: "Mutual funds",
  stock: "Stocks",
  cash: "Cash",
  savings: "Savings",
  unknown: "Other",
};

/** "mutual_fund" -> "Mutual funds"; unknown keys are tidied ("foo_bar" -> "Foo bar"). */
export function assetClassLabel(key: string): string {
  const k = key.trim().toLowerCase();
  if (ASSET_CLASS_LABELS[k]) return ASSET_CLASS_LABELS[k];
  const t = key.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
