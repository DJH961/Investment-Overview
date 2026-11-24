import type { components } from "../../lib/api-types";
import { formatDate, formatMoney, formatPercent, formatPp, signOf } from "../../lib/format";
import { RATE_RANGE_LABELS, type RateRange } from "../../lib/queries/currencyRate";

/**
 * The Currency page's one sign and digit rule (7.3.1), used by every section:
 *
 * - money: `<Money signed>` (whole units on the page);
 * - a percent: signed, one digit ("+1.2%", "−0.4%");
 * - points (a gap between two returns): signed, one digit ("+1.9 pp", "0.0 pp");
 * - the color comes from the same rounding as the text, so a figure that prints as
 *   zero is never blue or orange, and rounding never flips the color.
 */
export const PCT_DIGITS = 1;
export const PP_DIGITS = 1;

export type RangeWindowDto = components["schemas"]["RangeWindow"];

/** "+1.2%" / "−0.4%" / "0.0%": a signed percent with the page's one digit. */
export const pctText = (v: number | null | undefined) => formatPercent(v, { signed: true, digits: PCT_DIGITS });

/** "+1.9 pp" / "−0.3 pp" / "0.0 pp": always signed, one digit. */
export const ppText = (v: number | null | undefined) => formatPp(v, PP_DIGITS);

/** The tone of a fraction printed with one digit in percent or points (two more as a fraction). */
export const fractionTone = (v: number | null | undefined) => signOf(v, PCT_DIGITS + 2);

/** "tailwind" / "headwind" / "neutral" from the same rounding the text uses. */
export function fractionKind(v: number | null | undefined): "tailwind" | "headwind" | "neutral" {
  const t = fractionTone(v);
  return t === "pos" ? "tailwind" : t === "neg" ? "headwind" : "neutral";
}

/**
 * The page range as the server resolved it (`window`, the same in every section), for a
 * panel's meta line: "YTD · 1 Jan 2026 – 23 Nov 2026 · live". 1D is today, live, since
 * the last close; a range that ends now says "live" (today's move is in it).
 */
export function windowText(w: RangeWindowDto | null | undefined, range?: RateRange | string): string | null {
  if (!w) return null;
  const label = RATE_RANGE_LABELS[(range ?? w.key) as RateRange] ?? (range ?? w.key).toUpperCase();
  if (w.key === "1d") return `${label} · today, since the ${formatDate(w.through)} close${w.live ? " · live" : ""}`;
  const span = `${formatDate(w.start)} – ${formatDate(w.through)}`;
  return `${label} · ${span}${w.live ? " · live" : ""}`;
}

/** The regular conversion amount in euros: whole when it is whole, else with cents. */
export const euroText = (n: number | null | undefined) =>
  formatMoney(n, "EUR", { digits: n != null && Number.isInteger(n) ? 0 : 2 });

/** Digits for what a euro amount buys: small amounts (under 1,000) need cents. */
export const investDigits = (amountEur: number | null | undefined) =>
  amountEur != null && amountEur < 1000 ? 2 : 0;

/** Epoch ms of the last day before you started (Max only), or null. */
export function contextUntilMs(w: RangeWindowDto | null | undefined): number | null {
  if (!w?.context_until) return null;
  // The whole day is context: through its end (UTC), so a sample stamped that day counts.
  const t = Date.parse(`${w.context_until}T23:59:59Z`);
  return Number.isFinite(t) ? t : null;
}

/** A chart's real time span (ms) from its first and last point, for `formatAxisDate`. */
export function spanOf(times: number[]): number {
  const valid = times.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  return Math.max(...valid) - Math.min(...valid);
}
