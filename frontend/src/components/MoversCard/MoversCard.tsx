import clsx from "clsx";
import { Card } from "../Card";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { formatDayLabel, todayIn } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import "./MoversCard.scss";

type Movers = OverviewDto["movers"];
type Mover = Movers["winners"][number];

/** "biggest move" when ranked by money ("total"), else "top %". */
export function moverTag(reason: string): string {
  return reason === "total" ? "biggest move" : "top %";
}

function MoverList({ title, movers, ccy }: { title: string; movers: Mover[]; ccy: string }) {
  return (
    <div className="movers-card__col">
      <h3 className="movers-card__title">{title}</h3>
      {movers.length === 0 ? (
        <p className="movers-card__muted">None</p>
      ) : (
        <ul className="movers-card__list">
          {movers.map((m) => {
            const pct = <Percent ratio={toNum(m.pct)} signed colored />;
            const money = <Money amount={toNum(m.move)} currency={ccy} signed colored compact />;
            const byMoney = m.reason === "total";
            return (
              <li key={m.symbol} className="movers-card__mover">
                <span className="movers-card__who">
                  <span className="movers-card__symbol" title={m.name}>
                    {m.symbol}
                  </span>
                  <span className="movers-card__tag">{moverTag(m.reason)}</span>
                </span>
                {/* The figure it earned its slot on leads; the other trails. */}
                <span className="movers-card__figures">
                  <span className="movers-card__lead">{byMoney ? money : pct}</span>
                  <span className="movers-card__trail">{byMoney ? pct : money}</span>
                </span>
              </li>
            );
          })}
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

/** Overview "Top movers": winners and losers with the ranking tag; open by default, foldable. */
export function MoversCard({ movers, currency, loading, className }: MoversCardProps) {
  const timeZone = useTimeZone();
  const basis = movers?.basis_date;
  const basisLabel = basis ? (basis === todayIn(timeZone) ? "today" : `last close · ${formatDayLabel(basis)}`) : undefined;
  return (
    <Card className={clsx("movers-card", className)} title="Top movers" collapsibleId="overview.movers" subtitle={basisLabel}>
      {loading ? (
        <Skeleton height="6rem" />
      ) : (
        <div className="movers-card__grid">
          <MoverList title="Winners" movers={movers?.winners ?? []} ccy={currency} />
          <MoverList title="Losers" movers={movers?.losers ?? []} ccy={currency} />
        </div>
      )}
    </Card>
  );
}
