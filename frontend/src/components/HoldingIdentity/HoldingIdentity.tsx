import clsx from "clsx";
import { Link } from "react-router";
import { isNavRow, PriceTick } from "../Freshness";
import { Percent } from "../Percent";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import "./HoldingIdentity.scss";

export type MoverBadge = "winner" | "loser";

export interface HoldingPillsProps {
  row: HoldingRowDto;
  /** The market trades and this row's day move is current (callers know the stale rule). */
  live?: boolean;
  /** "top winner" / "top loser" (Overview movers setting). */
  badge?: MoverBadge;
  /** The ✓ "up to date with the latest close" title while the market is shut. */
  tick?: string | null;
  /** Show "≈ est." while the ETF twin estimates the day (default: when pending). */
  est?: boolean;
}

/**
 * The one set of status pills a holding carries everywhere (Overview list, phone
 * list, desktop table): warnings first (they wrap to a second line, never clip),
 * then live, CASH / NAV, the estimate cue, the up-to-date tick and the mover badge.
 * Every pill is a word, so no status depends on color.
 */
export function HoldingPills({ row, live = false, badge, tick = null, est }: HoldingPillsProps) {
  const showEst = est ?? Boolean(row.twin?.pending);
  return (
    <>
      {row.value_warning && <span className="holding-identity__pill holding-identity__pill--warn">stale value</span>}
      {row.price_data_warning && (
        <span className="holding-identity__pill holding-identity__pill--warn">bad history</span>
      )}
      {live && <span className="holding-identity__pill holding-identity__pill--live">live</span>}
      {row.is_money_market && <span className="holding-identity__pill">CASH</span>}
      {!row.is_money_market && isNavRow(row) && <span className="holding-identity__pill">NAV</span>}
      {showEst && (
        <span
          className="holding-identity__pill holding-identity__pill--est"
          title={row.twin ? `Not the official NAV: estimated from ${row.twin.symbol}` : undefined}
        >
          ≈ est.
        </span>
      )}
      <PriceTick title={tick} />
      {badge && (
        <span className={clsx("holding-identity__pill", `holding-identity__pill--${badge}`)}>
          {badge === "winner" ? "top winner" : "top loser"}
        </span>
      )}
    </>
  );
}

/**
 * The muted "≈ VOO +0.42%" line under a NAV fund while its twin estimates the day.
 * The "≈" and the sign carry the meaning; color does not.
 */
export function HoldingTwinLine({ row, className }: { row: HoldingRowDto; className?: string }) {
  const twin = row.twin;
  if (!twin || !twin.pending) return null;
  const pct = toNum(twin.est_today_pct);
  if (pct === null) return null;
  return (
    <span
      className={clsx("holding-identity__twin", className)}
      title={`Estimated from the ETF ${twin.symbol} until ${row.symbol}'s NAV posts`}
    >
      ≈ {twin.symbol} <Percent ratio={pct} signed />
    </span>
  );
}

export interface HoldingIdentityProps extends HoldingPillsProps {
  /** Link the symbol to the holding page (off inside a button, e.g. the phone row). */
  link?: boolean;
  /** Name lines before the ellipsis (table: 1; lists: 2). */
  nameLines?: 1 | 2;
  /** Draw the twin line under the name. */
  twinLine?: boolean;
  className?: string;
}

/** Symbol (+ pills), name and the twin line: the first cell of every holding list. */
export function HoldingIdentity({
  row,
  link = true,
  nameLines = 2,
  twinLine = true,
  className,
  ...pills
}: HoldingIdentityProps) {
  return (
    <span className={clsx("holding-identity", className)}>
      <span className="holding-identity__line">
        {link ? (
          <Link to={`/holdings/${row.instrument_id}`} className="holding-identity__symbol holding-identity__symbol--link" aria-label={`Open ${row.symbol}`}>
            {row.symbol}
          </Link>
        ) : (
          <strong className="holding-identity__symbol">{row.symbol}</strong>
        )}
        <HoldingPills row={row} {...pills} />
      </span>
      <span
        className={clsx("holding-identity__name", nameLines === 1 && "holding-identity__name--one")}
        title={row.name}
        data-truncate-ok
      >
        {row.name}
      </span>
      {twinLine && <HoldingTwinLine row={row} />}
    </span>
  );
}
