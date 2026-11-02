import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatMoney, formatNumber } from "../../lib/format";
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

/** Row tint class: calm green/red wash for holdings in profit / loss. */
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
        <dd>{formatMoney(toNum(row.price_native), row.native_currency)}</dd>
      </div>
      <div>
        <dt>Shares</dt>
        <dd>{formatNumber(toNum(row.shares), 4)}</dd>
      </div>
      <div>
        <dt>Cost basis</dt>
        <dd>
          <Money amount={toNum(row.cost_basis)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Capital gain</dt>
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
