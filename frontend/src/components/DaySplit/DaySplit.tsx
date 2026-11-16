import clsx from "clsx";
import { Moon, Sun } from "lucide-react";
import { InfoTip } from "../InfoTip";
import { Money } from "../Money";
import { Percent } from "../Percent";
import "./DaySplit.scss";

/** The one explanation of the overnight part, shared by every place that shows the split. */
export const DAY_SPLIT_TIP =
  "☀ Session: the market's move during US market hours. ☾ Overnight: the currency's move outside them, from the last close to the next open. Both are part of today's figure; after the close ☾ shows how the currency is moving overnight.";

/** Hover text for each symbol: ☀ the session, ☾ the overnight currency move. */
const SESSION_TITLE = "Session: the market's move (prices and the currency during market hours)";
const OVERNIGHT_TITLE = "Overnight: the currency's move outside US market hours";

/** Smallest overnight move worth showing: 0.005 % of the baseline (or half a cent without a %). */
const MIN_PCT = 0.00005;
const MIN_MONEY = 0.005;

/**
 * Whether the currency moved enough since the close to be worth a line. A quiet evening
 * (and any USD view of a USD holding, where nothing moves overnight) shows nothing
 * rather than "Overnight 0.00 %".
 */
export function daySplitMoved(overnightPct: number | null, overnight: number | null = null): boolean {
  if (overnightPct !== null) return Math.abs(overnightPct) >= MIN_PCT;
  return overnight !== null && Math.abs(overnight) >= MIN_MONEY;
}

export interface DaySplitProps {
  /** The session's move as a fraction (server figure). Nothing is drawn without it. */
  sessionPct: number | null;
  /** The overnight currency move as a fraction of the same baseline (server figure). */
  overnightPct: number | null;
  /** Money fallback for the overnight part when no percent is available. */
  overnight?: number | null;
  currency: string;
  /**
   * `inline`: "☀ +0.81 %  ☾ −0.45 % (i)" (graph header, hero, phone rows). `stacked`:
   * the same on one small line without the (i), right-aligned for a table cell (the Day
   * column). `list`: the same, left-aligned, for a narrow tile (the KPI "Price move").
   */
  layout?: "inline" | "stacked" | "list";
  className?: string;
  "data-testid"?: string;
}

/** The per-holding split fields of a holdings row (server figures in the reporting currency). */
export interface HoldingDaySplitFields {
  day_session_pct?: string | null;
  day_overnight_pct?: string | null;
  day_overnight?: string | null;
}

/** Whether a holdings row carries a split worth a line (EUR view, server fields present and moved). */
export function hasSplit(row: HoldingDaySplitFields & { day_session_pct?: string | null }, currency: string): boolean {
  if (currency !== "EUR") return false;
  const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));
  return num(row.day_session_pct) !== null && daySplitMoved(num(row.day_overnight_pct), num(row.day_overnight));
}

/** A holding's own split (`day_session*` / `day_overnight*`); draws nothing when the row has none. */
export function HoldingDaySplit({
  row,
  currency,
  ...rest
}: { row: HoldingDaySplitFields; currency: string } & Pick<DaySplitProps, "layout" | "className" | "data-testid">) {
  const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));
  return (
    <DaySplit
      sessionPct={num(row.day_session_pct)}
      overnightPct={num(row.day_overnight_pct)}
      overnight={num(row.day_overnight)}
      currency={currency}
      {...rest}
    />
  );
}

/**
 * The day's move is two things: the session (everything since the open after the open,
 * the last session's move after the close) and the currency's overnight move (last night's
 * while the market trades, close to now after the close).
 * This is the one place that words and colours them, so the graph, the hero, the KPI tile
 * and every holding read the same. In hide mode only percents show (`Money` masks itself).
 */
export function DaySplit({
  sessionPct,
  overnightPct,
  overnight = null,
  currency,
  layout = "inline",
  className,
  "data-testid": testId = "day-split",
}: DaySplitProps) {
  // Only the euro view has an overnight currency move to explain (owner): the USD view
  // never shows a split, not even for a euro-priced holding.
  if (currency !== "EUR") return null;
  if (sessionPct === null || !daySplitMoved(overnightPct, overnight)) return null;
  const compact = layout !== "inline";
  return (
    <span
      className={clsx(
        "day-split",
        compact && "day-split--compact",
        layout === "stacked" && "day-split--end",
        className,
      )}
      data-testid={testId}
    >
      <span className="day-split__part" title={SESSION_TITLE}>
        <Sun className="day-split__icon" aria-hidden />
        <span className="day-split__label">Session</span>
        <Percent ratio={sessionPct} signed colored />
      </span>
      <span className="day-split__part" title={OVERNIGHT_TITLE}>
        <Moon className="day-split__icon" aria-hidden />
        <span className="day-split__label">Overnight</span>
        {overnightPct !== null ? (
          <Percent ratio={overnightPct} signed colored />
        ) : (
          <Money amount={overnight} currency={currency} signed colored />
        )}
      </span>
      {!compact && <InfoTip label="session and overnight" content={DAY_SPLIT_TIP} />}
    </span>
  );
}
