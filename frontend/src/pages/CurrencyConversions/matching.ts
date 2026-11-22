import { formatDate, formatMoney, formatNumber, getFormatPrefs, todayIn } from "../../lib/format";
import type { DepositMatch, DepositStatus, FxConversion } from "../../lib/queries/manage";

/** A deposit may be paid by a conversion dated up to this many days after it (contract). */
export const PIN_WINDOW_DAYS = 7;

/** "12 Mar 2025 · €2,770 → $3,000 · 1.0830" in the app's date, number and currency formats. */
export function conversionName(c: Pick<FxConversion, "date" | "eur_sent" | "usd_received" | "rate">): string {
  return [
    formatDate(c.date),
    `${formatMoney(Number(c.eur_sent), "EUR", { digits: 0 })} → ${formatMoney(Number(c.usd_received), "USD", { digits: 0 })}`,
    formatNumber(Number(c.rate), 4),
  ].join(" · ");
}

const PROVIDER_LABELS: Record<string, string> = { wise: "Wise", revolut: "Revolut", other: "Other" };

/** "Wise", "Revolut", "Other" or "" for a conversion's provider. */
export function providerLabel(provider: string | null | undefined): string {
  return provider ? (PROVIDER_LABELS[provider] ?? "") : "";
}

/** "16/10/2026 · Wise" (the provider is left out when it is not set). */
export function conversionTitle(c: Pick<FxConversion, "date" | "provider">): string {
  return [formatDate(c.date), providerLabel(c.provider)].filter(Boolean).join(" · ");
}

/** "861.730000" -> "861.73", "1000.000000" -> "1000": the server pads, a form should not. */
export function trimDecimal(value: string | null | undefined): string {
  if (!value) return "";
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** "Fri 20/11/2026": a weekday and the date in the chosen layout. */
export function weekdayDate(iso: string): string {
  const day = new Intl.DateTimeFormat(getFormatPrefs().locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
  return `${day} ${formatDate(iso)}`;
}

/** The "vs ECB" figure: "−0.56 %" (a plain number, neutral text, no pos/neg colour). */
export function offPctText(offPct: string | null | undefined): string {
  if (offPct === null || offPct === undefined) return "–";
  const pct = Number(offPct) * 100;
  if (!Number.isFinite(pct)) return "–";
  if (Math.abs(pct) < 0.005) return "0.00 %";
  return `${pct < 0 ? "−" : "+"}${formatNumber(Math.abs(pct), 2)} %`;
}

/** "0.56 % below ECB" for the phone line; null without a figure. */
export function offPctWords(offPct: string | null | undefined): string | null {
  if (offPct === null || offPct === undefined) return null;
  const pct = Number(offPct) * 100;
  if (!Number.isFinite(pct)) return null;
  if (Math.abs(pct) < 0.005) return "at the ECB rate";
  return `${formatNumber(Math.abs(pct), 2)} % ${pct < 0 ? "below" : "above"} ECB`;
}

export interface EcbCell {
  /** Main text: the rate, or "No fixing" / "Not yet". */
  text: string;
  /** Muted second line: the fixing's own day when it is not the conversion's day. */
  from: string | null;
  /** Tooltip explaining a missing fixing. */
  title?: string;
}

/**
 * The ECB column. A weekend or holiday conversion is compared with the last settled
 * fixing before it, labelled with that date. Without any: "Not yet" for today (the
 * fixing is published in the afternoon), otherwise "No fixing".
 */
export function ecbCell(
  c: Pick<FxConversion, "date" | "ecb_rate" | "ecb_rate_date">,
  today: string = todayIn(getFormatPrefs().timeZone),
): EcbCell {
  if (c.ecb_rate) {
    const own = !c.ecb_rate_date || c.ecb_rate_date === c.date;
    return {
      text: formatNumber(Number(c.ecb_rate), 4),
      from: own ? null : weekdayDate(c.ecb_rate_date as string),
      title: own ? undefined : "No fixing on this day; the last one before it is used.",
    };
  }
  if (c.date >= today) return { text: "Not yet", from: null, title: "Today's ECB fixing is published in the afternoon." };
  return { text: "No fixing", from: null, title: "The ECB publishes no fixing on weekends and holidays." };
}

/** Short name for a slice: date and the all-in rate. */
export function sliceName(date: string, rate: string): string {
  return `${formatDate(date)} conversion at ${formatNumber(Number(rate), 4)}`;
}

/**
 * "you are 0.23 % under it": the typed rate against the ECB fixing. A single-instant ratio of two
 * rates for display only; the server owns every return.
 */
export function offEcbText(rate: number | null, ecb: number | null): string | null {
  if (rate === null || ecb === null || !(rate > 0) || !(ecb > 0)) return null;
  const pct = (rate / ecb - 1) * 100;
  if (Math.abs(pct) < 0.005) return "you are at it";
  return `you are ${formatNumber(Math.abs(pct), 2)} % ${pct < 0 ? "under" : "over"} it`;
}

export type StatusTone = "pos" | "warn" | "neutral";
export interface StatusLook {
  label: string;
  tone: StatusTone;
  icon: "check" | "half" | "ecb" | "pin";
}

/** Status of a deposit for display; a pin wins the label only when the deposit is fully matched. */
export function depositStatusLook(status: DepositStatus, pinned: boolean): StatusLook {
  if (pinned && status === "matched") return { label: "Pinned", tone: "neutral", icon: "pin" };
  switch (status) {
    case "matched":
      return { label: "Matched", tone: "pos", icon: "check" };
    case "partial":
      return { label: "Partly matched", tone: "warn", icon: "half" };
    default:
      return { label: "ECB only", tone: "neutral", icon: "ecb" };
  }
}

/** The short chip on a Transactions row: "Your rate" (matched or partial) or "ECB". */
export function rateChipLabel(status: DepositStatus): "Your rate" | "ECB" {
  return status === "ecb_only" ? "ECB" : "Your rate";
}

/** Deposit id -> match, for the client-side join on the Transactions tab. */
export function depositsById(deposits: readonly DepositMatch[]): Map<number, DepositMatch> {
  return new Map(deposits.map((d) => [d.transaction_id, d]));
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Conversions a deposit may be pinned to: dated up to 7 days after it, nearest date first. */
export function pinCandidates(deposit: Pick<DepositMatch, "date">, conversions: readonly FxConversion[]): FxConversion[] {
  const limit = addDays(deposit.date, PIN_WINDOW_DAYS);
  const apart = (iso: string) => Math.abs(Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${deposit.date}T00:00:00Z`));
  return conversions
    .filter((c) => c.date <= limit)
    .sort((a, b) => apart(a.date) - apart(b.date) || b.id - a.id);
}

export interface PinDraft {
  conversion_id: number;
  usd: string;
}

/** Client-side mirror of the server's pin rules, to explain a mistake before sending. */
export function validatePins(
  deposit: Pick<DepositMatch, "date" | "usd">,
  drafts: readonly PinDraft[],
  conversions: readonly FxConversion[],
): string | null {
  const byId = new Map(conversions.map((c) => [c.id, c]));
  const limit = addDays(deposit.date, PIN_WINDOW_DAYS);
  let total = 0;
  for (const p of drafts) {
    const usd = Number(p.usd.replace(",", "."));
    const c = byId.get(p.conversion_id);
    if (!c) return "That conversion no longer exists.";
    if (!Number.isFinite(usd) || usd <= 0) return "Enter a USD amount above zero for each pinned conversion.";
    if (c.date > limit) return `A conversion can be at most ${PIN_WINDOW_DAYS} days after the deposit.`;
    if (usd > Number(c.usd_received)) return "A pin cannot take more dollars than the conversion brought in.";
    total += usd;
  }
  if (total > Number(deposit.usd) + 1e-9) return "The pins add up to more than the deposit.";
  return null;
}
