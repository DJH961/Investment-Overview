import { ArrowLeftRight, CircleMinus, CirclePlus, Coins, Repeat, Split } from "lucide-react";
import type { ReactNode } from "react";
import type { ChartSession } from "../../components/Chart";
import { formatAxisDate, formatDate, formatTime } from "../../lib/format";
import type { ChartSessionDto, HoldingRange } from "../../lib/queries/holding-detail";

/** "1D", "YTD", "All". */
export const rangeLabel = (r: string): string => (r === "all" ? "All" : r.toUpperCase());

const DAY = 86_400_000;

/** Axis label for a range: clock times intraday, short dates for months, years beyond. */
export function axisFormat(range: HoldingRange | string, xMode: "date" | "time" | undefined) {
  if (xMode === "time" || range === "1d") return (t: number) => formatTime(new Date(t));
  if (range === "1w") return (t: number) => formatAxisDate(t, 0);
  const short = range === "1m" || range === "3m" || range === "6m";
  return (t: number) => formatAxisDate(t, short ? 0 : 400 * DAY);
}

export function tooltipFormat(range: HoldingRange | string, xMode: "date" | "time" | undefined) {
  if (xMode === "time" || range === "1d" || range === "1w") {
    return (t: number) => `${formatDate(new Date(t).toISOString().slice(0, 10))} ${formatTime(new Date(t))}`;
  }
  return (t: number) => formatDate(new Date(t).toISOString().slice(0, 10));
}

/** Contract sessions are `{open, close}`; the Chart also wants the day for its band label. */
export function chartSessions(sessions: ChartSessionDto[] | undefined): ChartSession[] {
  return (sessions ?? []).map((s) => ({ date: s.open.slice(0, 10), open: s.open, close: s.close }));
}

export interface KindLook {
  label: string;
  icon: ReactNode;
}

const ICON = { size: 16, "aria-hidden": true } as const;

/** Every transaction kind as an icon + a word (never colour alone). */
export function kindLook(kind: string): KindLook {
  switch (kind) {
    case "buy":
      return { label: "Buy", icon: <CirclePlus {...ICON} /> };
    case "sell":
      return { label: "Sell", icon: <CircleMinus {...ICON} /> };
    case "dividend_cash":
      return { label: "Dividend", icon: <Coins {...ICON} /> };
    case "dividend_reinvest":
      return { label: "Reinvested", icon: <Repeat {...ICON} /> };
    case "split":
      return { label: "Split", icon: <Split {...ICON} /> };
    case "transfer_in":
      return { label: "Moved in", icon: <ArrowLeftRight {...ICON} /> };
    case "transfer_out":
      return { label: "Moved out", icon: <ArrowLeftRight {...ICON} /> };
    default:
      return { label: kind.replace(/_/g, " "), icon: <ArrowLeftRight {...ICON} /> };
  }
}

/** Age of a tranche: "41 d" under a year, "2 y 41 d" beyond (whole days from the server). */
export function formatAge(days: number): string {
  if (days < 365) return `${days} d`;
  const y = Math.floor(days / 365);
  const d = days - y * 365;
  return d === 0 ? `${y} y` : `${y} y ${d} d`;
}

const ASSET_CLASS: Record<string, string> = {
  etf: "ETF",
  mutual_fund: "Mutual fund",
  stock: "Stock",
  cash: "Cash",
  savings: "Savings",
  equity: "Equity",
};

export const assetClassLabel = (c: string | null | undefined): string | null =>
  c ? (ASSET_CLASS[c] ?? c.replace(/_/g, " ")) : null;
