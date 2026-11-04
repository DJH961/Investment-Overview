import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { holdingPriceTime, PriceStamps } from "../Freshness";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { toNum, useHoldings, type HoldingRowDto, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import { usePersistentState } from "../../lib/usePersistentState";
import "./OverviewHoldings.scss";

/** How many positions stay open above the fold (largest first). */
export const OVERVIEW_HOLDINGS_LIMIT = 8;

export interface OverviewHoldingsProps {
  currency: ReportingCurrency;
  /** Overview movers, to badge the winners/losers in the list. */
  movers?: OverviewDto["movers"];
}

export function topHoldings(rows: HoldingRowDto[], limit = OVERVIEW_HOLDINGS_LIMIT): HoldingRowDto[] {
  return byValue(rows).slice(0, limit);
}

/** Every position, largest first. */
export function byValue(rows: HoldingRowDto[]): HoldingRowDto[] {
  return [...rows].sort((a, b) => (toNum(b.value) ?? -Infinity) - (toNum(a.value) ?? -Infinity));
}

function Row({
  row,
  ccy,
  badge,
  timeZone,
  maxWeight,
}: {
  row: HoldingRowDto;
  ccy: string;
  badge?: "winner" | "loser";
  timeZone?: string;
  /** Largest weight in the list: the weight bars share its scale. */
  maxWeight: number;
}) {
  const stale = row.daily_is_stale;
  const weight = toNum(row.weight_pct);
  const live = row.market_open && !stale;
  return (
    <li className="overview-holdings__row" data-symbol={row.symbol}>
      <span className="overview-holdings__who">
        <span className="overview-holdings__symbol">
          {row.symbol}
          {live && <span className="overview-holdings__pill overview-holdings__pill--live">live</span>}
          {row.is_money_market && <span className="overview-holdings__pill">PAR</span>}
          {row.value_warning && (
            <span className="overview-holdings__pill overview-holdings__pill--warn">stale value</span>
          )}
          {row.price_data_warning && (
            <span className="overview-holdings__pill overview-holdings__pill--warn">bad history</span>
          )}
          {badge && (
            <span className={clsx("overview-holdings__pill", `overview-holdings__pill--${badge}`)}>
              {badge === "winner" ? "top winner" : "top loser"}
            </span>
          )}
        </span>
        <span className="overview-holdings__name" title={row.name}>
          {row.name}
        </span>
      </span>
      <span className="overview-holdings__weight">
        <span className="overview-holdings__weight-bar" aria-hidden>
          <span
            className="overview-holdings__weight-fill"
            style={{ width: `${weight !== null && maxWeight > 0 ? Math.min((weight / maxWeight) * 100, 100) : 0}%` }}
          />
        </span>
        <span className="overview-holdings__num">
          <Percent ratio={weight} digits={1} />
        </span>
      </span>
      <span className="overview-holdings__cell overview-holdings__value">
        <span className="overview-holdings__main">
          <Money amount={toNum(row.value)} currency={ccy} />
        </span>
        <span className="overview-holdings__sub overview-holdings__sub--phone">
          <Percent ratio={weight} digits={1} /> of portfolio
        </span>
      </span>
      <span className={clsx("overview-holdings__cell", stale && "overview-holdings__today--stale")}>
        <span className="overview-holdings__main">
          <Percent ratio={toNum(row.today_pct)} signed colored={!stale} />
        </span>
        <span className="overview-holdings__sub">
          <Money amount={toNum(row.today_move)} currency={ccy} signed colored={!stale} />
        </span>
      </span>
      <span className="overview-holdings__cell overview-holdings__total">
        <span className="overview-holdings__main">
          <Money amount={toNum(row.total_return)} currency={ccy} signed colored />
        </span>
        <span className="overview-holdings__sub">
          <Percent ratio={toNum(row.total_growth)} signed />
        </span>
      </span>
      <PriceStamps
        className="overview-holdings__asof"
        price={holdingPriceTime(row)}
        updated={row.updated_at}
        layout="stack"
        terse
        options={{ timeZone }}
      />
    </li>
  );
}

/**
 * Compact table of every position on the Overview: the largest stay open, the
 * rest sit in an inline fold in the same grid (remembered in
 * `iv.overview.holdings.open`), with a link to the full table.
 */
export function OverviewHoldings({ currency, movers }: OverviewHoldingsProps) {
  const q = useHoldings(currency);
  const timeZone = useTimeZone();
  const listId = useId();
  const [open, setOpen] = usePersistentState<boolean>("overview.holdings.open", false);
  const winners = new Set(movers?.winners.map((m) => m.symbol) ?? []);
  const losers = new Set(movers?.losers.map((m) => m.symbol) ?? []);
  const all = q.data ? byValue(q.data.holdings) : [];
  const more = Math.max(0, all.length - OVERVIEW_HOLDINGS_LIMIT);
  const rows = open ? all : all.slice(0, OVERVIEW_HOLDINGS_LIMIT);
  const maxWeight = Math.max(0, ...all.map((r) => toNum(r.weight_pct) ?? 0));
  return (
    <Card
      className="overview-holdings"
      title="Holdings"
      collapsibleId="overview.holdings"
      actions={
        <Link className="overview-holdings__link" to="/holdings">
          Full table
        </Link>
      }
    >
      {q.isError && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="8rem" />
      ) : (
        <>
          <ul className="overview-holdings__list" id={listId}>
            <li className="overview-holdings__head" aria-hidden>
              <span>Holding</span>
              <span className="overview-holdings__head-weight">Weight</span>
              <span className="overview-holdings__head-num">Value</span>
              <span className="overview-holdings__head-num">Day</span>
              <span className="overview-holdings__head-num overview-holdings__head-total">Since buying</span>
              <span className="overview-holdings__head-asof">Price as of</span>
            </li>
            {rows.map((r) => (
              <Row
                key={r.instrument_id}
                row={r}
                ccy={currency}
                timeZone={timeZone}
                maxWeight={maxWeight}
                badge={winners.has(r.symbol) ? "winner" : losers.has(r.symbol) ? "loser" : undefined}
              />
            ))}
          </ul>
          {more > 0 && (
            <button
              type="button"
              className="overview-holdings__fold"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronDown
                className={clsx("overview-holdings__fold-icon", open && "overview-holdings__fold-icon--open")}
                aria-hidden
              />
              {open ? "Show fewer" : `Show all ${all.length} holdings`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
