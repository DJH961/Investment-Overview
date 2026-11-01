import { Card } from "../Card";
import { Percent } from "../Percent";
import { formatNumber } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import "./CurrencyBox.scss";

export interface CurrencyBoxProps {
  data: OverviewDto;
}

/**
 * Overview currency card: investment return versus currency effect, plus the
 * EUR/USD rate and today's move. (Home of the later daily currency box.)
 */
export function CurrencyBox({ data }: CurrencyBoxProps) {
  const split = data.currency.return_split;
  const today = data.currency.today;
  return (
    <Card title="Return split" subtitle="Investment return versus currency effect" collapsibleId="overview.currency">
      <dl className="currency-box">
        <div>
          <dt>Total return (EUR)</dt>
          <dd>
            <Percent ratio={toNum(split?.total_return_eur)} signed colored />
          </dd>
        </div>
        <div>
          <dt>Investment</dt>
          <dd>
            <Percent ratio={toNum(split?.investment_return)} signed colored />
          </dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>
            <Percent ratio={toNum(split?.currency_effect_pp)} signed colored />
          </dd>
        </div>
        <div>
          <dt>EUR/USD</dt>
          <dd>{formatNumber(toNum(data.fx_eur_usd), 4)}</dd>
        </div>
        <div>
          <dt>Rate move today</dt>
          <dd>
            <Percent ratio={toNum(today?.rate_move_pct)} signed colored />
          </dd>
        </div>
      </dl>
    </Card>
  );
}
