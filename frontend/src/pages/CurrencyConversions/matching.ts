import { formatDate, formatMoney, formatNumber } from "../../lib/format";
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

/** Conversions a deposit may be pinned to: dated up to 7 days after it, newest first. */
export function pinCandidates(deposit: Pick<DepositMatch, "date">, conversions: readonly FxConversion[]): FxConversion[] {
  const limit = addDays(deposit.date, PIN_WINDOW_DAYS);
  return conversions
    .filter((c) => c.date <= limit)
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
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
