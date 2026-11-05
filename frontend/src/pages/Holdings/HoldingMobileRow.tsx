import clsx from "clsx";
import { ChevronDown, LineChart } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { PriceTick } from "../../components/Freshness";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatMoney, formatQuantity } from "../../lib/format";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { Flags, HoldingDetails, RowStamp, tintClass } from "./HoldingParts";

interface Props {
  row: HoldingRowDto;
  ccy: string;
  /** This row's price time, only when it differs from the list's (else nothing is shown). */
  stamp?: string | null;
  /** "Up to date with the latest close" while the market is shut (see `holdingMarks`). */
  tick?: string | null;
  /** "Not updated yesterday — an earlier session's move" for a stale day move. */
  staleMove?: string | null;
  onOpenChart: (row: HoldingRowDto) => void;
}

/**
 * Collapsed: the key figures without a tap, in a fixed 3 x 2 grid of label-over-
 * value cells (nothing is cut off at 360 px, and a currency switch never moves
 * the list); the price time only when it differs from the list's. Expanded:
 * all details + the price chart.
 */
export function HoldingMobileRow({ row, ccy, stamp = null, tick = null, staleMove = null, onOpenChart }: Props) {
  const [open, setOpen] = useState(false);
  const detailId = `holding-detail-${row.instrument_id}`;
  const stale = staleMove !== null;
  const shares = toNum(row.shares);
  return (
    <li className={clsx("holdings-page__item", tintClass(row))} data-search-row>
      <button
        type="button"
        className="holdings-page__item-head"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="holdings-page__item-title">
          <span className="holdings-page__item-line">
            <strong>{row.symbol}</strong>
            <Flags row={row} />
          </span>
          <span className="holdings-page__muted holdings-page__item-name">{row.name}</span>
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
            <span className="holdings-page__chip-key">P/L</span>
            <Money amount={toNum(row.capital_gain)} currency={ccy} signed colored compact />
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
      {open && (
        <>
          <HoldingDetails id={detailId} row={row} ccy={ccy} />
          <div className="holdings-page__item-actions">
            <Button variant="secondary" leftIcon={<LineChart aria-hidden size={16} />} onClick={() => onOpenChart(row)}>
              Price chart
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
