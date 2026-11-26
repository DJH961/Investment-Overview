import { formatDate, formatMonth, formatMoney, formatNumber, getFormatPrefs } from "../../../../lib/format";
import { fractionTone, PP_DIGITS } from "../../numbers";

/**
 * Exchange sessions inferred from a 1W series: runs of samples with no long hole between them.
 * The Impact payload carries no session list, so a closed market (night, weekend) shows as a
 * hole; each run becomes one band of the Chart's `session` axis, like the Overview 1W chart.
 */
export function sessionsFromTimes(times: number[]): { date: string; open: number; close: number }[] {
  const ts = times.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (ts.length < 2) return [];
  const steps = ts
    .slice(1)
    .map((t, i) => t - ts[i])
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const median = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  const hole = Math.max(4 * median, 90 * 60_000);
  const out: { date: string; open: number; close: number }[] = [];
  let start = ts[0];
  for (let i = 1; i <= ts.length; i++) {
    if (i === ts.length || ts[i] - ts[i - 1] > hole) {
      if (ts[i - 1] > start) out.push({ date: new Date(ts[i - 1]).toISOString().slice(0, 10), open: start, close: ts[i - 1] });
      if (i < ts.length) start = ts[i];
    }
  }
  return out;
}

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
