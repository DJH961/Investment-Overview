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
