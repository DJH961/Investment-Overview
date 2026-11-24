import { formatDate, formatMonth, formatMoney, formatNumber, getFormatPrefs } from "../../../../lib/format";
import { fractionTone, PP_DIGITS } from "../../numbers";

/** "2026-03" -> "Mar" (bar labels); anything else passes through. */
export function monthShort(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) return label;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString(getFormatPrefs().locale, {
    month: "short",
    timeZone: "UTC",
  });
}

/** A record's period: a day (ISO date), a month ("YYYY-MM") or a year ("YYYY"). */
export function periodLabel(label: string | null | undefined): string {
  if (!label) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(label)) return formatDate(label.slice(0, 10));
  if (/^\d{4}-\d{2}$/.test(label)) return formatMonth(label, "short");
  return label;
}

/** A small signed amount for a dense cell ("+€1.2K", "−€640"). */
export function compactSigned(v: number | null, ccy: string): string {
  if (v === null) return "";
  // Under a thousand: whole units ("+€7", never "+€7.38"); above: two significant digits ("−€16K").
  if (Math.abs(v) < 1000) return formatMoney(Math.round(v), ccy, { narrow: true, signed: true, digits: 0 });
  return formatMoney(v, ccy, { compact: true, narrow: true, signed: true, significant: 2 });
}

/** The returns are time-weighted (the server's `RETURNS_TIP`, word for word). */
export const RETURNS_TIP =
  "These returns are time-weighted: each day's growth is chained, so deposits do not distort them, and they can differ from the Overview's lifetime return, which is money-weighted.";

/**
 * A gap in points as a size ("1.9 pp"), always with "lower" / "higher" beside it (never
 * a bare unsigned size): the page's one digit, the same rounding as `ppText`.
 */
export const ppSize = (pp: number) => `${formatNumber(Math.abs(pp) * 100, PP_DIGITS)} pp`;
/** Rounds to 0.0 pp: say "about the same", never "0.0 pp lower". */
export const ppFlat = (pp: number) => fractionTone(pp) === "flat";
/** "lower" / "higher" from the same rounding as the size. */
export const ppDirection = (pp: number) => (fractionTone(pp) === "neg" ? "lower" : "higher");

/** "Euro return 1.9 pp lower than the dollar return" (both computed on their own). */
export function gapWords(pp: number): string {
  return ppFlat(pp) ? "Euro and dollar returns about the same" : `Euro return ${ppSize(pp)} ${ppDirection(pp)} than the dollar return`;
}
