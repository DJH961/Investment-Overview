import clsx from "clsx";
import { ChevronDown, Link2 } from "lucide-react";
import { Fragment, useId, useMemo } from "react";
import { Link } from "react-router";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { foldStamps, formatStamp, holdingMarks, isNavRow, PriceStamps, PriceTick, sentenceCase } from "../Freshness";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { formatPp } from "../../lib/format";
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

/** "└┄" connector: dashed L from the row above to the twin line (decorative). */
function TwinLink() {
  return <span className="overview-holdings__twin-link" aria-hidden />;
}

/** Whether the row carries a twin line (estimate while pending, else how far off it was). */
export function hasTwinLine(row: HoldingRowDto): boolean {
  const t = row.twin;
  if (!t) return false;
  return t.pending ? t.est_value != null : toNum(t.divergence?.last_pp ?? null) !== null;
}

/**
 * One quiet line under a NAV fund whose ETF twin is estimating it (NAV not posted yet):
 * `└┄ [≈ est.] VOO · today 14:02   ≈value   ≈+0.61% ≈+€254`. Once the NAV posted it
 * only says how far the twin was off, until the next open. Nothing here is official.
 */
function TwinSubRow({ row, ccy, timeZone }: { row: HoldingRowDto; ccy: string; timeZone?: string }) {
  const twin = row.twin;
  if (!twin) return null;
  if (!twin.pending) {
    const pp = toNum(twin.divergence?.last_pp ?? null);
    if (pp === null) return null;
    const money = toNum(twin.divergence?.last_money ?? null);
    return (
      <li
        className="overview-holdings__twin overview-holdings__twin--off"
        data-twin-for={row.symbol}
        aria-label={`${twin.symbol} twin accuracy for ${row.symbol}`}
      >
        <span className="overview-holdings__twin-who overview-holdings__twin-who--wide">
          <TwinLink />
          <Link2 className="overview-holdings__twin-icon" aria-hidden />
          <span className="overview-holdings__twin-note">
            twin was {formatPp(pp / 100)} off
            {money !== null && (
              <>
                {" ("}
                <Money amount={money} currency={ccy} signed digits={0} />
                {")"}
              </>
            )}
          </span>
        </span>
      </li>
    );
  }
  if (twin.est_value == null) return null;
  const age = twin.at ? formatStamp(twin.at, { timeZone }) : null;
  return (
    <li
      className="overview-holdings__twin"
      data-twin-for={row.symbol}
      aria-label={`Estimate for ${row.symbol} from ${twin.symbol}`}
    >
      <span className="overview-holdings__twin-who">
        <TwinLink />
        <span className="overview-holdings__twin-badge" title={`Not the official NAV: estimated from ${twin.symbol}`}>
          <Link2 className="overview-holdings__twin-icon" aria-hidden />
          ≈ est.
        </span>
        <span className="overview-holdings__twin-symbol">
          <span className="overview-holdings__twin-approx" aria-hidden>
            ≈{" "}
          </span>
          {twin.symbol}
        </span>
        {age && (
          <span className="overview-holdings__twin-age" title={`${twin.symbol} price as of ${age}`}>
            {age}
          </span>
        )}
      </span>
      <span className="overview-holdings__cell overview-holdings__twin-value">
        <span className="overview-holdings__twin-num">
          ≈<Money amount={toNum(twin.est_value)} currency={ccy} />
        </span>
      </span>
      <span className="overview-holdings__cell overview-holdings__twin-day">
        <span className="overview-holdings__twin-num">
          ≈<Percent ratio={toNum(twin.est_today_pct ?? null)} signed colored />
        </span>
        <span className="overview-holdings__twin-num overview-holdings__twin-sub">
          ≈<Money amount={toNum(twin.est_today_move ?? null)} currency={ccy} signed colored />
        </span>
      </span>
    </li>
  );
}

function Row({
  row,
  ccy,
  badge,
  stamp,
  tick,
  staleMove,
  maxWeight,
}: {
  row: HoldingRowDto;
  ccy: string;
  badge?: "winner" | "loser";
  /** This row's price time, only when it differs from the card's (see `foldStamps`). */
  stamp: string | null;
  /** The up-to-date ✓ title while the market is shut, else null. */
  tick: string | null;
  /** Why the day move is greyed (an earlier session's), else null. */
  staleMove: string | null;
  /** Largest weight in the list: the weight bars share its scale. */
  maxWeight: number;
}) {
  const stale = staleMove !== null;
  const weight = toNum(row.weight_pct);
  const live = row.market_open && !stale;
  return (
    <li className={clsx("overview-holdings__row", hasTwinLine(row) && "overview-holdings__row--twin")} data-symbol={row.symbol}>
      <span className="overview-holdings__who">
        <span className="overview-holdings__symbol">
          {row.symbol}
          {live && <span className="overview-holdings__pill overview-holdings__pill--live">live</span>}
          {row.is_money_market && <span className="overview-holdings__pill">CASH</span>}
          {!row.is_money_market && isNavRow(row) && <span className="overview-holdings__pill">NAV</span>}
          <PriceTick title={tick} />
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
        {stamp && (
          <span className="overview-holdings__asof" title={`Price as of ${stamp}`}>
            <span className="overview-holdings__asof-key">Price as of</span> {sentenceCase(stamp)}
          </span>
        )}
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
      <span
        className={clsx("overview-holdings__cell", stale && "overview-holdings__today--stale")}
        title={staleMove ?? undefined}
      >
        <span className="overview-holdings__main">
          <Percent ratio={toNum(row.today_pct)} signed colored={!stale} />
        </span>
        <span className="overview-holdings__sub">
          <Money amount={toNum(row.today_move)} currency={ccy} signed colored={!stale} />
        </span>
        {staleMove && <span className="overview-holdings__sr">{staleMove}</span>}
      </span>
      <span className="overview-holdings__cell overview-holdings__total">
        <span className="overview-holdings__main">
          <Money amount={toNum(row.total_return)} currency={ccy} signed colored />
        </span>
        <span className="overview-holdings__sub">
          <Percent ratio={toNum(row.total_growth)} signed />
        </span>
      </span>
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
  // The price time is said once, in the header; a row only shows its own when it differs.
  const stamps = useMemo(() => foldStamps(q.data?.holdings ?? [], { timeZone }), [q.data, timeZone]);
  const marks = useMemo(() => holdingMarks(q.data?.holdings ?? [], { timeZone }), [q.data, timeZone]);
  return (
    <Card
      className="overview-holdings"
      title="Holdings"
      subtitle={
        stamps.price || stamps.updated ? (
          <PriceStamps
            className="overview-holdings__stamps"
            priceText={stamps.price}
            updated={stamps.updated}
            options={{ timeZone }}
          />
        ) : undefined
      }
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
            </li>
            {rows.map((r) => (
              <Fragment key={r.instrument_id}>
                <Row
                  row={r}
                  ccy={currency}
                  stamp={stamps.rowPrice(r)}
                  tick={marks.tick(r)}
                  staleMove={marks.staleMove(r)}
                  maxWeight={maxWeight}
                  badge={winners.has(r.symbol) ? "winner" : losers.has(r.symbol) ? "loser" : undefined}
                />
                <TwinSubRow row={r} ccy={currency} timeZone={timeZone} />
              </Fragment>
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
