import clsx from "clsx";
import { holdingPriceTime, PriceStamps, sentenceCase } from "../../components/Freshness";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatMoney, formatQuantity } from "../../lib/format";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";

/** Money-market funds read "CASH" (as on the web companion), NAV-priced funds "NAV". */
export function Flags({ row }: { row: HoldingRowDto }) {
  return (
    <span className="holdings-page__flags">
      {row.is_money_market && <span className="holdings-page__flag">CASH</span>}
      {!row.is_money_market && row.price_type === "nav" && <span className="holdings-page__flag">NAV</span>}
      {row.value_warning && <span className="holdings-page__flag holdings-page__flag--warn">stale value</span>}
      {row.price_data_warning && <span className="holdings-page__flag holdings-page__flag--warn">bad history</span>}
    </span>
  );
}

/** A row's own price time, shown only when it differs from the header's (see `foldStamps`). */
export function RowStamp({ text, labelled = false }: { text: string | null; labelled?: boolean }) {
  if (!text) return null;
  return (
    <span className="holdings-page__row-stamp" title={`Price as of ${text}`}>
      <span className={clsx("holdings-page__row-stamp-key", labelled && "holdings-page__row-stamp-key--shown")}>
        Price as of
      </span>{" "}
      {labelled ? text : sentenceCase(text)}
    </span>
  );
}

/** Weight as a number with a thin bar on the table's shared scale (the largest weight fills it). */
export function WeightCell({ ratio, max }: { ratio: number | null; max: number }) {
  const width = ratio !== null && max > 0 ? Math.min((ratio / max) * 100, 100) : 0;
  return (
    <span className="holdings-page__weight">
      <Percent ratio={ratio} digits={1} />
      <span className="holdings-page__weight-bar" aria-hidden>
        <span className="holdings-page__weight-fill" style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

/** Row class for holdings in profit / loss: an accent edge (blue / orange), never a full-row wash. */
export function tintClass(row: HoldingRowDto): string | undefined {
  const gain = toNum(row.capital_gain);
  if (gain === null || gain === 0) return undefined;
  return gain > 0 ? "holdings-page__row--gain" : "holdings-page__row--loss";
}

export function HoldingDetails({ id, row, ccy }: { id?: string; row: HoldingRowDto; ccy: string }) {
  return (
    <dl id={id} className="holdings-page__detail">
      <div>
        <dt>Price</dt>
        <dd>{formatMoney(toNum(row.price_native), row.native_currency, { unmasked: true })}</dd>
      </div>
      <div>
        <dt>Price as of / updated</dt>
        <dd>
          <PriceStamps price={holdingPriceTime(row)} updated={row.updated_at} layout="stack" />
        </dd>
      </div>
      <div>
        <dt>Shares</dt>
        <dd>{formatQuantity(toNum(row.shares), 4)}</dd>
      </div>
      <div>
        <dt>Cost basis</dt>
        <dd>
          <Money amount={toNum(row.cost_basis)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Unrealised gain</dt>
        <dd>
          <Money amount={toNum(row.capital_gain)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Dividends</dt>
        <dd>
          <Money amount={toNum(row.dividends)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Total return (incl. dividends)</dt>
        <dd>
          <Money amount={toNum(row.total_return)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Growth</dt>
        <dd>
          <Percent ratio={toNum(row.total_growth)} signed colored />
        </dd>
      </div>
      <div>
        <dt>XIRR</dt>
        <dd>
          <Percent ratio={toNum(row.xirr)} signed colored />
        </dd>
      </div>
      <div>
        <dt>Weight</dt>
        <dd>
          <Percent ratio={toNum(row.weight_pct)} digits={1} />
        </dd>
      </div>
      <div>
        <dt>Expense</dt>
        <dd>
          <Percent ratio={toNum(row.expense_ratio)} />
        </dd>
      </div>
    </dl>
  );
}
