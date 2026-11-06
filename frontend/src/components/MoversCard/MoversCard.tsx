import clsx from "clsx";
import { Link2, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "../Card";
import { lastSessionLabel } from "../Freshness";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
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

/** Card subtitle: "Today" for today's moves, else "Last session · Tue". */
export function moversBasisLabel(basis: string | null | undefined, opts: { timeZone?: string; now?: Date } = {}) {
  if (!basis) return undefined;
  return lastSessionLabel(basis, opts) ?? "Today";
}

function MoverRow({ m, ccy, tone }: { m: Mover; ccy: string; tone: "pos" | "neg" }) {
  const byMoney = m.reason === "total";
  const Arrow = tone === "pos" ? TrendingUp : TrendingDown;
  // A fund ranked on its ETF twin's estimate: every figure on the row is that
  // estimate, so both carry "≈" and the pair is named in the chip beside the symbol.
  const twin = m.twin ?? null;
  const approx = twin ? (
    <span className="movers-card__approx" aria-hidden>
      ≈
    </span>
  ) : null;
  const pct = <Percent ratio={toNum(m.pct)} signed colored />;
  const money = <Money amount={toNum(m.move)} currency={ccy} signed colored compact />;
  return (
    <li className={clsx("movers-card__row", `movers-card__row--${tone}`)} data-symbol={m.symbol}>
      <Arrow className="movers-card__icon" aria-label={tone === "pos" ? "Up" : "Down"} />
      <span className="movers-card__who">
        <span className="movers-card__symbol-line">
          <span className="movers-card__symbol">{m.symbol}</span>
          {twin && (
            <span
              className="movers-card__est"
              data-testid="mover-twin"
              title={`Estimated from ${twin}: ${m.symbol} has not published today's NAV yet, so its ETF twin stands in.`}
            >
              <Link2 className="movers-card__est-icon" aria-hidden />≈ {twin}
            </span>
          )}
          <span className="movers-card__tag">{moverTag(m.reason)}</span>
        </span>
        {m.name && (
          <span className="movers-card__name" title={m.name}>
            {m.name}
          </span>
        )}
      </span>
      {/* The figure it earned its slot on leads; the other trails. */}
      <span className="movers-card__lead">
        {approx}
        {byMoney ? money : pct}
      </span>
      <span className="movers-card__trail">
        {approx}
        {byMoney ? pct : money}
      </span>
    </li>
  );
}

function MoverList({ title, movers, ccy, tone }: { title: string; movers: Mover[]; ccy: string; tone: "pos" | "neg" }) {
  const id = `movers-${tone}`;
  return (
    <section className={clsx("movers-card__col", `movers-card__col--${tone}`)} aria-labelledby={id}>
      <h3 className="movers-card__title" id={id}>
        {title}
      </h3>
      {movers.length === 0 ? (
        <p className="movers-card__empty">No {title.toLowerCase()}</p>
      ) : (
        <ul className="movers-card__list">
          {movers.map((m) => (
            <MoverRow key={m.symbol} m={m} ccy={ccy} tone={tone} />
          ))}
        </ul>
      )}
    </section>
  );
}

export interface MoversCardProps {
  /** Undefined while loading. */
  movers: Movers | undefined;
  /** Reporting currency. */
  currency: ReportingCurrency;
  loading: boolean;
  className?: string;
  /** Injected clock (tests). */
  now?: Date;
}

/**
 * Overview "Top movers": winners beside losers (stacked on a phone), one
 * aligned row per mover: arrow, symbol + ranking tag, name, then the figure it
 * ranked on and the other one. Open by default, foldable.
 *
 * A fund whose NAV is still pending competes on its ETF twin's estimate (the
 * server decides), and says so: an "≈ VOO" chip on the symbol line and "≈" on
 * both figures, so an estimate is never read as a published move.
 */
export function MoversCard({ movers, currency, loading, className, now }: MoversCardProps) {
  const timeZone = useTimeZone();
  const basisLabel = moversBasisLabel(movers?.basis_date, { timeZone, now });
  return (
    <Card className={clsx("movers-card", className)} title="Top movers" collapsibleId="overview.movers" meta={basisLabel}>
      {loading ? (
        <Skeleton height="6rem" />
      ) : (
        <div className="movers-card__grid">
          <MoverList title="Winners" movers={movers?.winners ?? []} ccy={currency} tone="pos" />
          <MoverList title="Losers" movers={movers?.losers ?? []} ccy={currency} tone="neg" />
        </div>
      )}
    </Card>
  );
}
