import clsx from "clsx";
import { Card } from "../Card";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { formatDate } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./MoversCard.scss";

type Movers = OverviewDto["movers"];
type Mover = Movers["winners"][number];

function MoverList({ title, movers, ccy }: { title: string; movers: Mover[]; ccy: string }) {
  return (
    <div className="movers-card__col">
      <h3 className="movers-card__title">{title}</h3>
      {movers.length === 0 ? (
        <p className="movers-card__muted">None</p>
      ) : (
        <ul className="movers-card__list">
          {movers.map((m) => (
            <li key={m.symbol} className="movers-card__mover">
              <span className="movers-card__symbol" title={m.name}>
                {m.symbol}
              </span>
              <Percent ratio={toNum(m.pct)} signed colored />
              <Money amount={toNum(m.move)} currency={ccy} signed colored compact />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface MoversCardProps {
  /** Undefined while loading. */
  movers: Movers | undefined;
  /** Reporting currency. */
  currency: ReportingCurrency;
  loading: boolean;
  className?: string;
}

/** Overview "Top movers": today's winners and losers. */
export function MoversCard({ movers, currency, loading, className }: MoversCardProps) {
  return (
    <Card
      className={clsx("movers-card", className)}
      title="Top movers"
      collapsibleId="overview.movers"
      subtitle={movers?.basis_date ? formatDate(movers.basis_date) : undefined}
    >
      {loading ? (
        <Skeleton height="6rem" />
      ) : (
        <div className="movers-card__grid">
          <MoverList title="Winners today" movers={movers?.winners ?? []} ccy={currency} />
          <MoverList title="Losers today" movers={movers?.losers ?? []} ccy={currency} />
        </div>
      )}
    </Card>
  );
}
