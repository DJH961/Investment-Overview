import clsx from "clsx";
import { DeltaBadge } from "../DeltaBadge";
import { InfoTip } from "../InfoTip";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { formatPercent, formatPp } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./OverviewHero.scss";

export interface OverviewHeroProps {
  /** Undefined while loading. */
  data: OverviewDto | undefined;
  currency: ReportingCurrency;
  loading: boolean;
}

/**
 * Headline: total value in both currencies and the day's move, labelled with
 * the server's day caption ("Today" / "Yesterday" / "Fri 30 Oct") and its
 * live/clock corner stamp, plus the investment-vs-currency return split.
 */
const SPLIT_TIP =
  "Since you started. Investment: the return of your holdings in the currency they trade in (mostly USD). " +
  "Currency: how much the EUR/USD exchange rate added (+) or took away (−) from your EUR return, in percentage points.";

function moveTip(ccy: string, ccy2: string, closed: boolean): string {
  return (
    `The change since the last close, in ${ccy}. ${ccy2}: the same change measured in ${ccy2}, ` +
    `so the gap between the two is the exchange-rate effect.` +
    (closed ? ` US markets are closed now, so dollar prices stand still and only the exchange rate moves.` : "")
  );
}

export function OverviewHero({ data, currency, loading }: OverviewHeroProps) {
  if (loading || !data) {
    return (
      <section className="overview-hero" aria-label="Portfolio value">
        <Skeleton height="1rem" width="30%" />
        <Skeleton height="2.5rem" width="55%" />
        <Skeleton height="1rem" width="40%" />
      </section>
    );
  }
  const k = data.kpis;
  const k2 = data.kpis_secondary;
  const cap = data.daily_caption;
  const split = data.currency.return_split;
  const ccy2 = data.secondary_ccy;
  const marketClosed = data.freshness?.market_state !== "open";
  // While US markets are shut the dollar value cannot move: say so instead of "0.00%".
  const usdFlat = marketClosed && toNum(k2?.daily_growth_pct ?? null) === 0;
  return (
    <section className="overview-hero" aria-label="Portfolio value">
      <div className="overview-hero__head">
        <span className="overview-hero__label">Portfolio value</span>
        {cap?.corner_text && (
          <span className={clsx("overview-hero__corner", cap.live && "overview-hero__corner--live")}>
            {cap.live && <span className="overview-hero__dot" aria-hidden />}
            {cap.corner_text}
          </span>
        )}
      </div>
      <div className="overview-hero__values">
        <span className="overview-hero__value">
          <Money amount={toNum(k.total_value)} currency={currency} />
        </span>
        {k2 && (
          <span className="overview-hero__value2">
            <Money amount={toNum(k2.total_value)} currency={ccy2} />
          </span>
        )}
      </div>
      <div className="overview-hero__move">
        <DeltaBadge value={toNum(k.daily_growth_pct)} />
        <Money amount={toNum(k.daily_move)} currency={currency} signed colored />
        <span className="overview-hero__day">{cap?.title ?? "Today"}</span>
        {k2?.daily_growth_pct != null && (
          <span className="overview-hero__muted overview-hero__usd">
            {usdFlat ? (
              `${ccy2} unchanged`
            ) : (
              <span>
                {ccy2} <Percent ratio={toNum(k2.daily_growth_pct)} signed />
              </span>
            )}
            <InfoTip label="today's move" content={moveTip(currency, ccy2, marketClosed)} />
          </span>
        )}
        {cap?.updated_text && <span className="overview-hero__muted">{cap.updated_text}</span>}
      </div>
      {split && (split.investment_return != null || split.currency_effect_pp != null) && (
        <p className="overview-hero__split">
          <span>
            Investment {formatPercent(toNum(split.investment_return), { signed: true })} · Currency{" "}
            {formatPp(toNum(split.currency_effect_pp))}
          </span>
          <InfoTip label="investment and currency return" content={SPLIT_TIP} />
        </p>
      )}
      {data.total_value_complete === false && (
        <p className="overview-hero__note">Some holdings have no live price yet; the total is incomplete.</p>
      )}
    </section>
  );
}
