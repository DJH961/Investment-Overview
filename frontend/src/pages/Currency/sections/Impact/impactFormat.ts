import { formatDate, formatMonth, formatMoney, getFormatPrefs } from "../../../../lib/format";

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
  return formatMoney(v, ccy, { compact: true, narrow: true, signed: true, significant: Math.abs(v) >= 1000 ? 2 : 3 });
}
