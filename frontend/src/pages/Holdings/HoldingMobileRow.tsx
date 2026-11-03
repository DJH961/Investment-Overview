import clsx from "clsx";
import { ChevronDown, LineChart } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatAxisDate, formatMoney, formatTime, formatQuantity } from "../../lib/format";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { Flags, HoldingDetails, tintClass } from "./HoldingParts";

/** "14:05" when the price carries a capture time, else the price date. */
export function asOfStamp(row: HoldingRowDto): string | null {
  if (row.updated_at) return formatTime(row.updated_at);
  if (row.price_as_of) return formatAxisDate(Date.parse(row.price_as_of), 0);
  return null;
}

interface Props {
  row: HoldingRowDto;
  ccy: string;
  onOpenChart: (row: HoldingRowDto) => void;
}

/** Collapsed: the key figures without a tap. Expanded: all details + the price chart. */
export function HoldingMobileRow({ row, ccy, onOpenChart }: Props) {
  const [open, setOpen] = useState(false);
  const detailId = `holding-detail-${row.instrument_id}`;
  const stamp = asOfStamp(row);
  const stale = row.daily_is_stale;
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
            title={stale ? "Last move; the market has not traded since" : undefined}
          >
            <Money amount={toNum(row.today_move)} currency={ccy} signed colored={!stale} />
            <Percent ratio={toNum(row.today_pct)} signed colored={!stale} />
          </span>
        </span>
        <ChevronDown aria-hidden size={16} className="holdings-page__chevron" />
        <span className="holdings-page__chips">
          <span className="holdings-page__chip">
            Px {formatMoney(toNum(row.price_native), row.native_currency, { unmasked: true })}
          </span>
          <span className="holdings-page__chip">{formatQuantity(toNum(row.shares), 4)} sh</span>
          <span className="holdings-page__chip">
            Growth <Percent ratio={toNum(row.total_growth)} signed colored />
          </span>
          <span className="holdings-page__chip">
            P/L <Money amount={toNum(row.capital_gain)} currency={ccy} signed colored compact />
          </span>
          <span className="holdings-page__chip">
            XIRR <Percent ratio={toNum(row.xirr)} signed colored />
          </span>
          {stamp && <span className="holdings-page__asof">as of {stamp}</span>}
        </span>
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
