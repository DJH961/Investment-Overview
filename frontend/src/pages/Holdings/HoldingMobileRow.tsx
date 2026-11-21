import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { daySplitMoved, HoldingDaySplit } from "../../components/DaySplit";
import { PriceTick } from "../../components/Freshness";
import { HoldingIdentity } from "../../components/HoldingIdentity";
import { HoldingPeek } from "../../components/HoldingPeek";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatMoney, formatQuantity } from "../../lib/format";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { RowStamp, tintClass } from "./HoldingParts";

interface Props {
  row: HoldingRowDto;
  ccy: string;
  /** This row's price time, only when it differs from the list's (else nothing is shown). */
  stamp?: string | null;
  /** "Up to date with the latest close" while the market is shut (see `holdingMarks`). */
  tick?: string | null;
  /** "Not updated yesterday — an earlier session's move" for a stale day move. */
  staleMove?: string | null;
}

/**
 * Collapsed: the key figures without a tap, in a fixed 3 x 2 grid of label-over-
 * value cells (nothing is cut off at 360 px, and a currency switch never moves
 * the list); the price time only when it differs from the list's. Expanded: the
 * compact peek (past week, four one-line facts, the ways into the holding page);
 * everything else lives on that page.
 */
export function HoldingMobileRow({ row, ccy, stamp = null, tick = null, staleMove = null }: Props) {
  const [open, setOpen] = useState(false);
  const detailId = `holding-detail-${row.instrument_id}`;
  const stale = staleMove !== null;
  const shares = toNum(row.shares);
  // After the close, when the currency moved: the day figure's session / overnight cut gets
  // its own line (a grid row only this row type adds, so quiet rows keep their height).
  const hasSplit =
    ccy === "EUR" &&
    !stale &&
    toNum(row.day_session_pct ?? null) !== null &&
    daySplitMoved(toNum(row.day_overnight_pct ?? null), toNum(row.day_overnight ?? null));
  return (
    <li className={clsx("holdings-page__item", tintClass(row))} data-search-row>
      <button
        type="button"
        className={clsx("holdings-page__item-head", hasSplit && "holdings-page__item-head--split")}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="holdings-page__item-title">
          {/* Inside the row button: the symbol is not a link (the peek has "Open"). */}
          <HoldingIdentity row={row} link={false} live={row.market_open && !stale} />
        </span>
        <span className="holdings-page__item-figures">
          <Money amount={toNum(row.value)} currency={ccy} />
          <span
            className={clsx("holdings-page__today", stale && "holdings-page__today--stale")}
            title={staleMove ?? undefined}
          >
            <Money amount={toNum(row.today_move)} currency={ccy} signed colored={!stale} />
            <Percent ratio={toNum(row.today_pct)} signed colored={!stale} />
            {staleMove && <span className="holdings-page__sr">{staleMove}</span>}
          </span>
        </span>
        {/* After the close, when the currency moved: the day figure's session / overnight cut. */}
        {hasSplit && (
          <HoldingDaySplit
            row={row}
            currency={ccy}
            marketOpen={row.market_open}
            className="holdings-page__item-split"
            data-testid="holding-day-split"
          />
        )}
        <ChevronDown aria-hidden size={16} className="holdings-page__chevron" />
        <span className="holdings-page__chips">
          <span className="holdings-page__chip">
            <span className="holdings-page__chip-key">Price</span>
            <span className="holdings-page__price">
              {formatMoney(toNum(row.price_native), row.native_currency, { unmasked: true })}
              <PriceTick title={tick} />
            </span>
          </span>
          <span className="holdings-page__chip">
            <span className="holdings-page__chip-key">Shares</span>
            {formatQuantity(shares, shares !== null && Number.isInteger(shares) ? 0 : 4)}
          </span>
          <span className="holdings-page__chip">
            <span className="holdings-page__chip-key">Total return</span>
            <Money amount={toNum(row.total_return)} currency={ccy} signed colored compact />
          </span>
          <span className="holdings-page__chip">
            <span className="holdings-page__chip-key">Weight</span>
            <Percent ratio={toNum(row.weight_pct)} digits={1} />
          </span>
          <span className="holdings-page__chip">
            <span className="holdings-page__chip-key">Growth</span>
            <Percent ratio={toNum(row.total_growth)} signed colored />
          </span>
          <span className="holdings-page__chip">
            <span className="holdings-page__chip-key">XIRR</span>
            <Percent ratio={toNum(row.xirr)} signed colored />
          </span>
        </span>
        {stamp && (
          <span className="holdings-page__item-stamp">
            <RowStamp text={stamp} labelled />
          </span>
        )}
      </button>
      {open && <HoldingPeek id={detailId} row={row} layout="phone" />}
    </li>
  );
}
