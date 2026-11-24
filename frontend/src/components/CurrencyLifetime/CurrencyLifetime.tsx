import clsx from "clsx";
import { Card } from "../Card";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Sparkline } from "../Sparkline";
import { TrendChip } from "../TrendChip";
import { formatNumber, formatPp, signOf } from "../../lib/format";
import { useHideAmounts } from "../../lib/hideAmounts";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { RateTrendDto } from "../../lib/queries/currencyRate";
import "./CurrencyLifetime.scss";

/** The 1-year rate line for the "EUR/USD now" tile, in the quote of the top switch (server values). */
export interface LifetimeRateLine {
  /** Daily rates, oldest first, in `quote`. */
  values: number[];
  /** Your average entry in the same quote (a faint dashed line). */
  avg: number | null;
  /** "1 $ in €" (EUR view) or "EUR/USD" (USD view). */
  quote: string;
  trend?: RateTrendDto | null;
}

export interface CurrencyLifetimeProps {
  data: OverviewDto;
  /** Overview: a 1-year sparkline and the dollar trend chip on the "EUR/USD now" tile. */
  rateLine?: LifetimeRateLine | null;
}

/**
 * Lifetime currency effect (web companion's Risk-tab card): today's rate versus
 * the average rate you bought at, what the euro's move did to your return, and
 * what cashing out now would bring home. Amounts are in EUR (the home currency).
 */
export function CurrencyLifetime({ data, rateLine }: CurrencyLifetimeProps) {
  const { hide } = useHideAmounts();
  const life = data.currency.lifetime ?? {};
  // Hide mode: the FX gain/loss as a share of what cashing out now would bring home.
  const fxPnl = toNum(life.fx_pnl_eur);
  const repat = toNum(life.repatriation_value_eur);
  const fxShare = fxPnl !== null && repat ? fxPnl / repat : null;
  const split = data.currency.return_split;
  // P12: in the USD view the currency effect on a dollar return is 0 by definition, so
  // the two middle tiles say what matters to a euro investor looking at dollars: the
  // dollar's move against the euro, and how far the euro return sits from the dollar
  // one (both server figures). Same tiles, same lines in both views: no height jump.
  const usdView = data.ccy === "USD";
  const change = usdView ? toNum(split?.usd_vs_eur_pct) : toNum(life.rate_change_pct);
  // A stronger euro (EUR/USD up) - a weaker dollar - is a headwind for a euro investor holding dollars.
  const favor = change === null ? "flat" : signOf(usdView ? change : -change, 3);
  const pp = usdView ? toNum(split?.eur_minus_usd_pp) : toNum(split?.currency_effect_pp);
  return (
    <Card title="Currency effect (lifetime)" collapsibleId="overview.currency-lifetime" className="currency-lifetime">
      <dl className="currency-lifetime__grid">
        <div
          className={clsx(
            "currency-lifetime__stat",
            rateLine && rateLine.values.length > 1 && "currency-lifetime__stat--rate",
          )}
        >
          <dt className="currency-lifetime__label">EUR/USD now</dt>
          <dd className="currency-lifetime__value">{formatNumber(toNum(life.current_rate), 4)}</dd>
          <dd className="currency-lifetime__sub">avg in {formatNumber(toNum(life.avg_invest_rate), 4)}</dd>
          {rateLine && rateLine.values.length > 1 ? (
            <dd className="currency-lifetime__spark" data-testid="lifetime-spark">
              <Sparkline
                values={rateLine.values}
                reference={rateLine.avg}
                tone="primary"
                stretch
                width={240}
                height={30}
                className="currency-lifetime__spark-line"
                ariaLabel={`${rateLine.quote}, last 12 months, with your average entry as a dashed line`}
              />
              <span className="currency-lifetime__spark-foot">
                <span className="currency-lifetime__spark-caption">{rateLine.quote} · last 12 months</span>
                {rateLine.avg !== null ? (
                  <span className="currency-lifetime__spark-caption">
                    <span className="currency-lifetime__spark-swatch" aria-hidden />
                    your avg {formatNumber(rateLine.avg, 4)}
                  </span>
                ) : null}
              </span>
              {rateLine.trend ? (
                <span className="currency-lifetime__spark-chip">
                  <TrendChip trend={rateLine.trend} />
                </span>
              ) : null}
            </dd>
          ) : null}
        </div>
        <div className="currency-lifetime__stat" data-testid="lifetime-rate-move">
          <dt className="currency-lifetime__label">{usdView ? "Dollar vs euro since buying" : "Euro since buying"}</dt>
          <dd className={clsx("currency-lifetime__value", `currency-lifetime__value--${favor}`)}>
            <Percent ratio={change} signed digits={1} />
          </dd>
          <dd className="currency-lifetime__sub">
            {favor === "pos" ? "tailwind" : favor === "neg" ? "headwind" : "no effect"}
          </dd>
        </div>
        <div className="currency-lifetime__stat" data-testid="lifetime-fx-gap">
          <dt className="currency-lifetime__label">{usdView ? "In euros vs dollars" : "FX effect on return"}</dt>
          <dd className={clsx("currency-lifetime__value", `currency-lifetime__value--${pp === null ? "flat" : signOf(pp, 3)}`)}>
            {formatPp(pp, 1)}
          </dd>
          <dd className="currency-lifetime__sub">
            {usdView ? "USD" : "investment"} <Percent ratio={toNum(split?.investment_return)} signed digits={1} /> · EUR{" "}
            <Percent ratio={toNum(split?.total_return_eur)} signed digits={1} />
          </dd>
        </div>
        <div className="currency-lifetime__stat">
          <dt className="currency-lifetime__label">FX gain/loss</dt>
          <dd className="currency-lifetime__value">
            {hide && fxShare !== null ? (
              <Percent ratio={fxShare} signed colored digits={1} />
            ) : (
              <Money amount={fxPnl} currency="EUR" signed colored digits={0} />
            )}
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
