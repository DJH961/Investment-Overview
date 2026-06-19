/**
 * Display formatting helpers. Values arrive as decimal.js `Decimal`; we render
 * with `Intl.NumberFormat` for locale-aware grouping and currency symbols.
 */
import type { Decimal } from "./decimal-config";

const NBSP = "\u00a0";

export function formatCurrency(value: Decimal | null, currency = "EUR"): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value.toNumber());
}

export function formatSignedCurrency(value: Decimal | null, currency = "EUR"): string {
  if (value === null) return "—";
  const base = formatCurrency(value.abs(), currency);
  if (value.isZero()) return base;
  return value.isNegative() ? `−${NBSP}${base}` : `+${NBSP}${base}`;
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
