import clsx from "clsx";
import { Card } from "../Card";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { formatNumber, formatPp, signOf } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import "./CurrencyLifetime.scss";

export interface CurrencyLifetimeProps {
  data: OverviewDto;
}

/**
 * Lifetime currency effect (web companion's Risk-tab card): today's rate versus
 * the average rate you bought at, what the euro's move did to your return, and
 * what cashing out now would bring home. Amounts are in EUR (the home currency).
 */
export function CurrencyLifetime({ data }: CurrencyLifetimeProps) {
  const life = data.currency.lifetime ?? {};
  const split = data.currency.return_split;
  const change = toNum(life.rate_change_pct);
  // A stronger euro (EUR/USD up) is a headwind for a euro investor holding dollars.
  const favour = change === null ? "flat" : signOf(-change);
  const pp = toNum(split?.currency_effect_pp);
  return (
    <Card title="Currency effect (lifetime)" collapsibleId="overview.currency-lifetime" className="currency-lifetime">
      <dl className="currency-lifetime__grid">
        <div className="currency-lifetime__stat">
          <dt className="currency-lifetime__label">EUR/USD now</dt>
          <dd className="currency-lifetime__value">{formatNumber(toNum(life.current_rate), 4)}</dd>
          <dd className="currency-lifetime__sub">avg in {formatNumber(toNum(life.avg_invest_rate), 4)}</dd>
        </div>
        <div className="currency-lifetime__stat">
          <dt className="currency-lifetime__label">Euro since buying</dt>
          <dd className={clsx("currency-lifetime__value", `currency-lifetime__value--${favour}`)}>
            <Percent ratio={change} signed />
          </dd>
          <dd className="currency-lifetime__sub">
            {favour === "pos" ? "tailwind" : favour === "neg" ? "headwind" : "no effect"}
          </dd>
        </div>
        <div className="currency-lifetime__stat">
          <dt className="currency-lifetime__label">FX effect on return</dt>
          <dd className={clsx("currency-lifetime__value", pp !== null && `currency-lifetime__value--${signOf(pp)}`)}>
            {formatPp(pp)}
          </dd>
          <dd className="currency-lifetime__sub">
            investment <Percent ratio={toNum(split?.investment_return)} signed /> · EUR{" "}
            <Percent ratio={toNum(split?.total_return_eur)} signed />
          </dd>
        </div>
        <div className="currency-lifetime__stat">
          <dt className="currency-lifetime__label">FX gain/loss</dt>
          <dd className="currency-lifetime__value">
            <Money amount={toNum(life.fx_pnl_eur)} currency="EUR" signed colored digits={0} />
          </dd>
        </div>
        <div className="currency-lifetime__stat">
          <dt className="currency-lifetime__label">If cashed out now</dt>
          <dd className="currency-lifetime__value">
            <Money amount={toNum(life.repatriation_value_eur)} currency="EUR" digits={0} />
          </dd>
        </div>
        <div className="currency-lifetime__stat">
          <dt className="currency-lifetime__label">Break-even rate</dt>
          <dd className="currency-lifetime__value">{formatNumber(toNum(life.breakeven_rate), 4)}</dd>
        </div>
      </dl>
    </Card>
  );
}
