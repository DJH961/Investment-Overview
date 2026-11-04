/** Display-only formatting via Intl. No business maths. */

export type Currency = string;

/** Supported number/date locales (Settings → Display; `display.locale`). */
export type Locale = "en-GB" | "de-DE" | "en-US";

/** Date layouts (`display.date_format`); "auto" follows the regional preset. */
export type DateFormat = "auto" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD" | "DD.MM.YYYY";
/** Number layouts (`display.number_format`); "auto" follows the regional preset. */
export type NumberFormat = "auto" | "1,234.56" | "1.234,56" | "1 234,56" | "1'234.56";

export interface FormatPrefs {
  /** Regional preset (`display.locale`): the fallback for date / number / clock on "auto"; also drives symbols and weekday names. */
  locale: Locale;
  dateFormat: DateFormat;
  numberFormat: NumberFormat;
  /** IANA zone for date-times; `undefined` = the browser's own zone. */
  timeZone: string | undefined;
  /** `true` 12-hour, `false` 24-hour, `undefined` = the locale's default. */
  hour12: boolean | undefined;
}

// Module-level so plain functions (no hooks) format with the user's prefs.
// `lib/displayPrefs.tsx` feeds these from the server settings (+ local cache).
let LOCALE: Locale = "en-GB";
let DATE_FORMAT: DateFormat = "auto";
let NUMBER_FORMAT: NumberFormat = "auto";
let TIME_ZONE: string | undefined;
let HOUR12: boolean | undefined;

/** Called by `lib/displayPrefs.tsx`; tests may call it directly. */
export function setFormatPrefs(prefs: Partial<FormatPrefs>): void {
  if (prefs.locale) LOCALE = prefs.locale;
  if (prefs.dateFormat) DATE_FORMAT = prefs.dateFormat;
  if (prefs.numberFormat) NUMBER_FORMAT = prefs.numberFormat;
  if ("timeZone" in prefs) TIME_ZONE = prefs.timeZone;
  if ("hour12" in prefs) HOUR12 = prefs.hour12;
}

export function getFormatPrefs(): FormatPrefs {
  return { locale: LOCALE, dateFormat: DATE_FORMAT, numberFormat: NUMBER_FORMAT, timeZone: TIME_ZONE, hour12: HOUR12 };
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

const NUMBER_SEPARATORS: Record<Exclude<NumberFormat, "auto">, { group: string; decimal: string }> = {
  "1,234.56": { group: ",", decimal: "." },
  "1.234,56": { group: ".", decimal: "," },
  "1 234,56": { group: "\u00a0", decimal: "," },
  "1'234.56": { group: "'", decimal: "." },
};

const LOCALE_NUMBER_FORMAT: Record<Locale, Exclude<NumberFormat, "auto">> = {
  "en-GB": "1,234.56",
  "de-DE": "1.234,56",
  "en-US": "1,234.56",
};

/** The effective number layout: the explicit choice, else the regional preset's. */
export function effectiveNumberFormat(): Exclude<NumberFormat, "auto"> {
  return NUMBER_FORMAT === "auto" ? LOCALE_NUMBER_FORMAT[LOCALE] : NUMBER_FORMAT;
}

/**
 * Formats with Intl (symbols, sign, compact suffix and their placement follow
 * the regional preset) but writes the group / decimal separators exactly as
 * chosen in `display.number_format`.
 */
function formatIntl(options: Intl.NumberFormatOptions, value: number): string {
  const sep = NUMBER_SEPARATORS[effectiveNumberFormat()];
  return new Intl.NumberFormat(LOCALE, options)
    .formatToParts(value)
    .map((p) => (p.type === "group" ? sep.group : p.type === "decimal" ? sep.decimal : p.value))
    .join("");
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
  return formatIntl(
    {
      style: "currency",
      currency,
      currencyDisplay: opts.narrow ? "narrowSymbol" : "symbol",
      notation: opts.compact ? "compact" : "standard",
      minimumFractionDigits: opts.compact ? 0 : digits,
      maximumFractionDigits: digits,
      // A real zero has no sign; the sample is never zero, so decide here.
      signDisplay: opts.signed && amount !== 0 ? "exceptZero" : "auto",
    },
    sample,
  ).replace(/\d/g, "•");
}

export function formatMoney(amount: number | null | undefined, currency: Currency, opts: MoneyOptions = {}): string {
  if (isMissing(amount)) return "–";
  if (HIDE_AMOUNTS && !opts.unmasked) return maskedMoney(amount, currency, opts);
  const digits = opts.digits ?? (opts.compact ? 1 : 2);
  return formatIntl(
    {
      style: "currency",
      currency,
      currencyDisplay: opts.narrow ? "narrowSymbol" : "symbol",
      notation: opts.compact ? "compact" : "standard",
      ...(opts.significant
        ? { maximumSignificantDigits: opts.significant }
        : { minimumFractionDigits: opts.compact ? 0 : digits, maximumFractionDigits: digits }),
      signDisplay: opts.signed ? "exceptZero" : "auto",
    },
    amount,
  );
}

/** `ratio` is a fraction: 0.0525 -> "5.25%". */
export function formatPercent(
  ratio: number | null | undefined,
  opts: { signed?: boolean; digits?: number } = {},
): string {
  if (isMissing(ratio)) return "–";
  const digits = opts.digits ?? 2;
  return formatIntl(
    {
      style: "percent",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: opts.signed ? "exceptZero" : "auto",
    },
    ratio,
  );
}

/** A share count / quantity: masked in hide mode (it reveals value next to public prices). */
export function formatQuantity(value: number | null | undefined, digits = 2): string {
  if (isMissing(value)) return "–";
  return HIDE_AMOUNTS ? MASK : formatNumber(value, digits);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (isMissing(value)) return "–";
  return formatIntl({ minimumFractionDigits: digits, maximumFractionDigits: digits }, value);
}

const isCalendarDate = (value: string | Date): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const LOCALE_DATE_FORMAT: Record<Locale, Exclude<DateFormat, "auto">> = {
  "en-GB": "DD/MM/YYYY",
  "de-DE": "DD.MM.YYYY",
  "en-US": "MM/DD/YYYY",
};

/** The effective date layout: the explicit choice, else the regional preset's. */
export function effectiveDateFormat(): Exclude<DateFormat, "auto"> {
  return DATE_FORMAT === "auto" ? LOCALE_DATE_FORMAT[LOCALE] : DATE_FORMAT;
}

/** `true` = 12-hour clock. An "Auto" clock follows the regional preset (en-US: 12-hour). */
export function effectiveHour12(): boolean {
  return HOUR12 ?? LOCALE === "en-US";
}

interface Ymd {
  y: string;
  m: string;
  d: string;
}

function ymdOf(d: Date, timeZone: string | undefined): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Lays out the date fields in the effective order / separator, dropping the token `omit`. */
function layoutDate(v: Ymd, omit: "YYYY" | "DD" | null = null): string {
  const pattern = effectiveDateFormat();
  const sep = /[^A-Z]/.exec(pattern)?.[0] ?? "/";
  return pattern
    .split(sep)
    .filter((t) => t !== omit)
    .map((t) => (t === "YYYY" ? v.y : t === "MM" ? v.m : v.d))
    .join(sep);
}

/** Clock time in the chosen 12 / 24-hour style ("14:05" / "2:05 PM"). */
function clockTime(d: Date, timeZone: string | undefined): string {
  const h12 = effectiveHour12();
  return new Intl.DateTimeFormat(h12 ? "en-US" : "en-GB", {
    hour: h12 ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: h12,
    timeZone,
  })
    .format(d)
    .replace(/\u202f/g, " ");
}

/**
 * A calendar date ("2026-03-05") is shown as that day everywhere (UTC); a
 * timestamp is shown in the user's timezone (`timeZone` overrides it). The
 * layout is always the chosen numeric one ("05/03/2026"); `style` is kept for
 * callers but no longer changes the output.
 */
export function formatDate(
  value: string | Date,
  _style: "short" | "medium" | "long" = "medium",
  timeZone?: string,
): string {
  const d = parseInstant(value);
  if (Number.isNaN(d.getTime())) return "–";
  const zone = isCalendarDate(value) ? "UTC" : (timeZone ?? TIME_ZONE);
  return layoutDate(ymdOf(d, zone));
}

export function formatTime(value: string | Date, timeZone?: string): string {
  const d = parseInstant(value);
  if (Number.isNaN(d.getTime())) return "–";
  return clockTime(d, timeZone ?? TIME_ZONE);
}

/**
 * Short chart-axis date: day and month ("05/10") when the axis spans under a
 * year, month and year ("10/2026") beyond that, in the chosen date layout.
 */
export function formatAxisDate(t: number, spanMs: number, timeZone?: string): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "–";
  const long = spanMs > 330 * 86_400_000;
  return layoutDate(ymdOf(d, timeZone ?? "UTC"), long ? "DD" : "YYYY");
}

/** "05/03/2026 14:30" in the user's timezone; "never" for a missing stamp. */
export function formatDateTime(value: string | Date | null | undefined, missing = "never"): string {
  if (value === null || value === undefined || value === "") return missing;
  const d = parseInstant(value);
  if (Number.isNaN(d.getTime())) return "–";
  return `${formatDate(d)} ${formatTime(d)}`;
}

/** Sign class helper: gains / losses / flat. */
export function signOf(value: number | null | undefined): "pos" | "neg" | "flat" {
  if (!value) return "flat";
  return value > 0 ? "pos" : "neg";
}

/** A server date-time without an offset ("2026-11-04T20:16:49.5") is naive UTC. */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Parses an instant the way the server means it: offset-less date-times are UTC
 * (the backend stores naive UTC), never the browser's local time. Calendar
 * dates ("2026-11-04") stay as `new Date()` reads them (UTC midnight).
 */
export function parseInstant(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" && NAIVE_DATETIME.test(value)) return new Date(`${value.replace(" ", "T")}Z`);
  return new Date(value);
}

function validDate(value: string | number | Date): Date | null {
  const d = parseInstant(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Fri 22:00" in `timeZone` (default: the browser's). */
export function formatWeekdayTime(value: string | number | Date, timeZone?: string): string {
  const d = validDate(value);
  if (!d) return "–";
  const zone = timeZone ?? TIME_ZONE;
  return `${new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: zone }).format(d)} ${clockTime(d, zone)}`;
}

/** "Mon 26 Oct 14:30" in `timeZone`. */
export function formatDayTime(value: string | number | Date, timeZone?: string): string {
  const d = validDate(value);
  if (!d) return "–";
  const zone = timeZone ?? TIME_ZONE;
  const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: zone }).format(d);
  return `${weekday} ${layoutDate(ymdOf(d, zone), "YYYY")} ${clockTime(d, zone)}`;
}

/** A calendar date (ISO "2026-10-30") as "Fri 30 Oct"; `weekday: "long"` gives just "Friday". */
export function formatDayLabel(value: string, style: "short" | "weekday" = "short"): string {
  const d = validDate(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!d) return "–";
  if (style === "weekday") return new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" }).format(d);
  const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" }).format(d);
  return `${weekday} ${layoutDate(ymdOf(d, "UTC"), "YYYY")}`;
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
    new Intl.DateTimeFormat(LOCALE, { ...o, timeZone: timeZone ?? TIME_ZONE }).format(d);
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
  return `${formatIntl({ minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: "exceptZero" }, ratio * 100)} pp`;
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
