import clsx from "clsx";
import { Moon, Sun } from "lucide-react";
import { InfoTip } from "../InfoTip";
import { Money } from "../Money";
import { Percent } from "../Percent";
import "./DaySplit.scss";

/**
 * The one explanation of ☀ and ☾, the same words everywhere (the owner's day rule):
 * Total = last night's currency + the session; while the market is open ☾ is last
 * night's move and is in the Total; after the close ☾ is tonight's and is not.
 */
export const DAY_SPLIT_LINES = {
  day: "Day: prices and currency while the US market is open.",
  night: "Night: currency while the US market is closed.",
  total: "Total = last night's ☾ + today's ☀. After the close, tonight's ☾ sits beside the Total, not in it.",
  estimate: "Funds without today's price use their ETF twin until it is out.",
} as const;

/** Plain-text form of the legend (titles, screen readers). */
export const DAY_SPLIT_TIP = `☀ ${DAY_SPLIT_LINES.day} ☾ ${DAY_SPLIT_LINES.night} ${DAY_SPLIT_LINES.total}`;

/** Hover text for each symbol. */
const SESSION_TITLE = `☀ ${DAY_SPLIT_LINES.day}`;
const OVERNIGHT_TITLE_OPEN = "☾ Last night's currency move, in today's Total.";
const OVERNIGHT_TITLE_SHUT = "☾ Tonight's currency move, beside the Total, not in it.";

/**
 * The ☀/☾ legend for an info tip: two symbol lines and the rule, a fourth line only
 * when an ETF-twin estimate is on screen. A legend, not a paragraph.
 */
export function DaySplitLegend({ estimate = false }: { estimate?: boolean }) {
  return (
    <span className="day-split-legend">
      <span className="day-split-legend__row">
        <Sun className="day-split-legend__icon" aria-hidden />
        <span>{DAY_SPLIT_LINES.day}</span>
      </span>
      <span className="day-split-legend__row">
        <Moon className="day-split-legend__icon" aria-hidden />
        <span>{DAY_SPLIT_LINES.night}</span>
      </span>
      <span className="day-split-legend__row day-split-legend__row--rule">
        <span className="day-split-legend__sign" aria-hidden>
          =
        </span>
        <span>{DAY_SPLIT_LINES.total}</span>
      </span>
      {estimate && (
        <span className="day-split-legend__row">
          <span className="day-split-legend__sign" aria-hidden>
            ≈
          </span>
          <span>{DAY_SPLIT_LINES.estimate}</span>
        </span>
      )}
    </span>
  );
}

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
   * Whether the US market is open (server `last_session.market_open` / graph or row
   * `market_open`): picks the ☾ tooltip. Defaults to shut, the case where ☾ is not in the total.
   */
  marketOpen?: boolean;
  /**
   * `inline`: "☀ +0.81 %  ☾ −0.45 % (i)" (graph header, hero, phone rows). `stacked`:
   * the same on one small line without the (i), right-aligned for a table cell (the Day
   * column). `list`: the same, left-aligned, for a narrow tile (the KPI "Day move").
   */
  layout?: "inline" | "stacked" | "list";
  /** An ETF-twin estimate is on screen: the legend adds its one extra line. */
  estimate?: boolean;
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
}: { row: HoldingDaySplitFields; currency: string } & Pick<
  DaySplitProps,
  "layout" | "className" | "data-testid" | "marketOpen"
>) {
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
 * This is the one place that words and colors them, so the graph, the hero, the KPI tile
 * and every holding read the same. In hide mode only percents show (`Money` masks itself).
 */
export function DaySplit({
  sessionPct,
  overnightPct,
  overnight = null,
  currency,
  marketOpen = false,
  layout = "inline",
  estimate = false,
  className,
  "data-testid": testId = "day-split",
}: DaySplitProps) {
  // Only the euro view has an overnight currency move to explain (owner): the USD view
  // never shows a split, not even for a euro-priced holding.
  if (currency !== "EUR") return null;
  if (sessionPct === null || !daySplitMoved(overnightPct, overnight)) return null;
  const compact = layout !== "inline";
  const day = (
    <span className="day-split__part" title={SESSION_TITLE}>
      <Sun className="day-split__icon" aria-hidden />
      <span className="day-split__label">Session</span>
      <Percent ratio={sessionPct} signed colored />
    </span>
  );
  const night = (
    <span className="day-split__part" title={marketOpen ? OVERNIGHT_TITLE_OPEN : OVERNIGHT_TITLE_SHUT}>
      <Moon className="day-split__icon" aria-hidden />
      <span className="day-split__label">Overnight</span>
      {overnightPct !== null ? (
        <Percent ratio={overnightPct} signed colored />
      ) : (
        <Money amount={overnight} currency={currency} signed colored />
      )}
    </span>
  );
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
      {/*
        The two parts side by side, in the order they happened (no equation: the
        headline pill already shows the day's total, owner). Open: last night's ☾,
        then the session ☀. After the close: the session ☀, then tonight's ☾.
      */}
      {marketOpen ? (
        <>
          {night}
          {day}
        </>
      ) : (
        <>
          {day}
          {night}
        </>
      )}
      {!compact && <InfoTip label="session and overnight" content={<DaySplitLegend estimate={estimate} />} />}
    </span>
  );
}
