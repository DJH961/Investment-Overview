import { formatMoney, formatQuantity as formatShares } from "../../lib/format";

/** API decimal string -> number for display (null when missing). */
export const num = (v: string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

/** Quantity with as many decimals as it has (max 6); masked in hide-numbers mode. */
export function formatQuantity(v: string | null | undefined): string {
  const n = num(v);
  if (n === null || Number.isNaN(n)) return "–";
  const decimals = (v ?? "").replace(/0+$/, "").split(".")[1]?.length ?? 0;
  return formatShares(n, Math.min(decimals, 6));
}

/** Fraction digits for a unit price: 4 below 1 (money-market, fractional units), else 2. */
export function priceDigits(v: string | null | undefined): number {
  const n = Math.abs(num(v) ?? 0);
  return n > 0 && n < 1 ? 4 : 2;
}

/** A unit price: shown even in hide-numbers mode (it reveals no holdings). */
export function formatPrice(v: string | null | undefined, currency: string): string {
  const n = num(v);
  return n === null ? "–" : formatMoney(n, currency, { unmasked: true, digits: priceDigits(v) });
}
