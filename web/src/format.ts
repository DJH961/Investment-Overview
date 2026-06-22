/**
 * Display formatting helpers. Values arrive as decimal.js `Decimal`; we render
 * with `Intl.NumberFormat` for locale-aware grouping and currency symbols.
 */
import type { Decimal } from "./decimal-config";
import { convertFromEur, displayAmount } from "./currency";

const NBSP = "\u00a0";

function formatMoneyValue(value: Decimal, code: string, fractionDigits = 2): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value.toNumber());
}

/**
 * Format a figure that carries both an EUR value and a pre-computed value in
 * the display currency (USD), preferring the latter so sums of historical
 * flows / point-in-time valuations are never rescaled by today's spot rate.
 * See {@link displayAmount}.
 */
export function formatDualCurrency(
  valueEur: Decimal | null,
  valueDisplay: Decimal | null,
): string {
  const picked = displayAmount(valueEur, valueDisplay);
  if (picked === null) return "—";
  return formatMoneyValue(picked.value, picked.code);
}

/** Signed (`+`/`−`) variant of {@link formatDualCurrency}. */
export function formatSignedDualCurrency(
  valueEur: Decimal | null,
  valueDisplay: Decimal | null,
): string {
  const picked = displayAmount(valueEur, valueDisplay);
  if (picked === null) return "—";
  const base = formatMoneyValue(picked.value.abs(), picked.code);
  if (picked.value.isZero()) return base;
  return picked.value.isNegative() ? `−${NBSP}${base}` : `+${NBSP}${base}`;
}

/**
 * Format a compute-layer amount in the active display currency (EUR or USD —
 * see currency.ts). Compute-layer figures are carried in EUR purely as the
 * internal FX-pivot (not because EUR is the base/primary currency — USD is the
 * native booked currency), so the conversion to the chosen display currency
 * happens here at render time.
 */
export function formatCurrency(value: Decimal | null): string {
  if (value === null) return "—";
  const { value: amount, code } = convertFromEur(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount.toNumber());
}

/**
 * A whole-currency amount (no cents). Used where the precision of cents is
 * noise rather than signal — e.g. the forward-projection table, whose figures
 * are hypothetical estimates and read more clearly rounded to the nearest unit.
 */
export function formatCurrencyWhole(value: Decimal | null): string {
  if (value === null) return "—";
  const { value: amount, code } = convertFromEur(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount.toNumber());
}

export function formatSignedCurrency(value: Decimal | null): string {
  if (value === null) return "—";
  const base = formatCurrency(value.abs());
  if (value.isZero()) return base;
  return value.isNegative() ? `−${NBSP}${base}` : `+${NBSP}${base}`;
}

/**
 * A compact EUR-denominated amount for chart axis ticks (e.g. "€39k", "$1.2M"),
 * rendered in the active display currency. Uses the currency symbol only, with
 * k/M suffixes so axis labels stay short.
 */
export function formatCurrencyShort(value: Decimal | null): string {
  if (value === null) return "—";
  const { value: amount, code } = convertFromEur(value);
  const num = amount.toNumber();
  const abs = Math.abs(num);
  const symbol = currencySymbol(code);
  const sign = num < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${symbol}${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${symbol}${trim(abs / 1_000)}k`;
  return `${sign}${symbol}${Math.round(abs)}`;
}

function trim(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function currencySymbol(code: string): string {
  return code === "USD" ? "$" : "€";
}

/** Render a ratio (0.1234 → "12.34%"). */
export function formatPercent(value: Decimal | null, digits = 2): string {
  if (value === null) return "—";
  return `${value.times(100).toNumber().toFixed(digits)}%`;
}

export function formatSignedPercent(value: Decimal | null, digits = 2): string {
  if (value === null) return "—";
  const pct = value.times(100).toNumber();
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

export function formatShares(value: Decimal): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(value.toNumber());
}

export function formatNativePrice(value: Decimal | null, currency: string): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value.toNumber());
}

/** Sign class for colour-coding: "pos", "neg", or "flat". */
export function signClass(value: Decimal | null): "pos" | "neg" | "flat" {
  if (value === null || value.isZero()) return "flat";
  return value.isNegative() ? "neg" : "pos";
}

export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

/**
 * A compact "how fresh is this price" label for a holding row.
 *
 * `at` is the epoch ms a live/cached price was observed; when null the price
 * came from the export and `fallbackDate` (the export's `as_of`, `YYYY-MM-DD`)
 * is shown instead. A same-day live price shows the clock time; an older one
 * shows the date, so it is always transparent how current each value is.
 */
export function formatAsOf(
  at: number | null | undefined,
  fallbackDate: string,
  now: Date = new Date(),
): string {
  if (at === null || at === undefined) {
    const parsed = new Date(fallbackDate);
    if (Number.isNaN(parsed.getTime())) return fallbackDate;
    return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "—";
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  return sameDay
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
