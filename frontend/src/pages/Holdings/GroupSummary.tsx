import { InfoTip } from "../../components/InfoTip";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import type { HoldingGroupDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { EstChip, WeightCell } from "./HoldingParts";

const EST_HELP =
  "Estimate: funds whose NAV for the last session has not posted yet are valued from their ETF twin. " +
  "The figure beside it is the official one.";

/**
 * A group's server-computed subtotals as ONE calm row in the table's column order:
 * value | weight | day | P/L | total return. Cost basis and dividends sit behind a
 * small (i). Nothing is summed in the browser.
 */
export function GroupSummary({ group, ccy }: { group: HoldingGroupDto; ccy: string }) {
  const estValue = toNum(group.est_value);
  const estMove = toNum(group.est_today_move);
  // A pending-NAV member contributes its last published move to today_move, so while an
  // estimate exists the estimated percentage is the one that describes today.
  const estPct = toNum(group.est_today_pct);
  return (
    <section className="holdings-page__gsum" aria-label={`Subtotal ${group.key}`}>
      <div className="holdings-page__gcell holdings-page__gcell--value">
        <span className="holdings-page__gkey">Value</span>
        <span className="holdings-page__gfig">
          <Money amount={toNum(group.value)} currency={ccy} />
        </span>
        {estValue !== null && (
          <span className="holdings-page__gest" data-testid="group-est-value">
            <EstChip />
            <Money amount={estValue} currency={ccy} />
            <InfoTip label="the estimated value" content={EST_HELP} />
          </span>
        )}
      </div>
      <div className="holdings-page__gcell holdings-page__gcell--weight">
        <span className="holdings-page__gkey">Weight</span>
        <WeightCell ratio={toNum(group.weight_pct)} max={1} start />
      </div>
      <div className="holdings-page__gcell holdings-page__gcell--day">
        <span className="holdings-page__gkey">Day</span>
        <span className="holdings-page__gfig">
          <Money amount={toNum(group.today_move)} currency={ccy} signed colored />{" "}
          <span className="holdings-page__gpct">
            (<Percent ratio={toNum(group.today_pct)} signed colored />)
          </span>
        </span>
        {estMove !== null && (
          <span className="holdings-page__gest" data-testid="group-est-move">
            <EstChip />
            <Money amount={estMove} currency={ccy} signed />
            {estPct !== null && (
              <span className="holdings-page__gpct">
                (<Percent ratio={estPct} signed colored />)
              </span>
            )}
          </span>
        )}
      </div>
      <div className="holdings-page__gcell holdings-page__gcell--gain">
        {/* Named for what it is: dividends are stripped out of it, so a cash group
            reads 0 here while "Total return" beside it carries the income it earned. */}
        <span className="holdings-page__gkey">Unrealised gain</span>
        <span className="holdings-page__gfig">
          <Money amount={toNum(group.capital_gain)} currency={ccy} signed colored />
        </span>
      </div>
      <div className="holdings-page__gcell holdings-page__gcell--return">
        <span className="holdings-page__gkey">Total return</span>
        <span className="holdings-page__gfig">
          <Money amount={toNum(group.total_return)} currency={ccy} signed colored />
          {toNum(group.total_growth) !== null && (
            <span className="holdings-page__gpct">
              (<Percent ratio={toNum(group.total_growth)} signed colored />)
            </span>
          )}
          <InfoTip
            label="cost basis, dividends and the return percentage"
            content={
              <>
                Cost basis <Money amount={toNum(group.cost_basis)} currency={ccy} />
                {" · "}Dividends <Money amount={toNum(group.dividends)} currency={ccy} />
                {". The percentage is a simple return on cost (total return / cost basis), not a compounded one."}
              </>
            }
          />
        </span>
      </div>
    </section>
  );
}
