import { formatNumber, formatPercent } from "../../../../lib/format";
import type { DollarQuoteDto } from "../../../../lib/queries/currencyDollar";

type Field = DollarQuoteDto["field"];

/** A rate in the view's quote: `€0.8590` (one dollar in euros) or `$1.1641` (one euro in dollars). */
export function rateText(v: number | null, field: Field): string {
  if (v === null) return "–";
  return `${field === "inverse" ? "€" : "$"}${formatNumber(v, 4)}`;
}

/** The quote in words, for labels and tips. */
export const quoteWords = (field: Field) => (field === "inverse" ? "one dollar in euros" : "one euro in dollars");

export const pct = (v: number | null, digits = 1) => formatPercent(v, { signed: true, digits });
export const share = (v: number | null) => formatPercent(v, { digits: 0 });

/**
 * Good or bad for a lens: the dollar's own change (`inverse`) is good for dollars you
 * hold and bad for euros you still convert. Tiny moves are flat.
 */
export type Lean = "tailwind" | "headwind" | "neutral";
export const leanOf = (v: number | null, flat = 0.0005): Lean =>
  v === null || Math.abs(v) < flat ? "neutral" : v > 0 ? "tailwind" : "headwind";
