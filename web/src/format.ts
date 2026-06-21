/**
 * Display formatting helpers. Values arrive as decimal.js `Decimal`; we render
 * with `Intl.NumberFormat` for locale-aware grouping and currency symbols.
 */
import type { Decimal } from "./decimal-config";
import { convertFromEur } from "./currency";

const NBSP = "\u00a0";

/**
 * Format an **EUR-denominated** amount in the active display currency (EUR or
 * USD — see currency.ts). All compute-layer figures are in EUR, so the
 * conversion happens here at render time.
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
