import clsx from "clsx";
import { Link } from "react-router";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { formatTime } from "../../lib/format";
import { toNum, useHoldings, type HoldingRowDto, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import "./OverviewHoldings.scss";

/** How many positions the compact list shows (largest first). */
export const OVERVIEW_HOLDINGS_LIMIT = 8;

export interface OverviewHoldingsProps {
  currency: ReportingCurrency;
  /** Overview movers, to badge the winners/losers in the list. */
  movers?: OverviewDto["movers"];
}

export function topHoldings(rows: HoldingRowDto[], limit = OVERVIEW_HOLDINGS_LIMIT): HoldingRowDto[] {
  return [...rows].sort((a, b) => (toNum(b.value) ?? -Infinity) - (toNum(a.value) ?? -Infinity)).slice(0, limit);
}

function Row({
  row,
  ccy,
  badge,
  timeZone,
}: {
  row: HoldingRowDto;
  ccy: string;
  badge?: "winner" | "loser";
  timeZone?: string;
}) {
  const stale = row.daily_is_stale;
  return (
    <li className="overview-holdings__row" data-symbol={row.symbol}>
      <span className="overview-holdings__who">
        <span className="overview-holdings__symbol">
          {row.symbol}
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
      <span className="overview-holdings__value">
        <Money amount={toNum(row.value)} currency={ccy} />
        <span className="overview-holdings__fresh">
          {row.market_open && !stale ? "LIVE" : "updated"}
          {row.updated_at ? ` · ${formatTime(row.updated_at, timeZone)}` : ""}
        </span>
      </span>
      <span className={clsx("overview-holdings__today", stale && "overview-holdings__today--stale")}>
        <Percent ratio={toNum(row.today_pct)} signed colored={!stale} />
        <Money amount={toNum(row.today_move)} currency={ccy} signed colored={!stale} />
      </span>
    </li>
  );
}

/** Compact, foldable list of the largest positions on the Overview, with a link to the full table. */
export function OverviewHoldings({ currency, movers }: OverviewHoldingsProps) {
  const q = useHoldings(currency);
  const timeZone = useTimeZone();
  const winners = new Set(movers?.winners.map((m) => m.symbol) ?? []);
  const losers = new Set(movers?.losers.map((m) => m.symbol) ?? []);
  const rows = q.data ? topHoldings(q.data.holdings) : [];
  const more = q.data ? q.data.holdings.length - rows.length : 0;
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
          <ul className="overview-holdings__list">
            {rows.map((r) => (
              <Row
                key={r.instrument_id}
                row={r}
                ccy={currency}
                timeZone={timeZone}
                badge={winners.has(r.symbol) ? "winner" : losers.has(r.symbol) ? "loser" : undefined}
              />
            ))}
          </ul>
          {more > 0 && (
            <p className="overview-holdings__more">
              {more} more in the <Link to="/holdings">full table</Link>.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
