import clsx from "clsx";
import type { ReactNode } from "react";
import { DeltaBadge } from "../DeltaBadge";
import { InfoTip } from "../InfoTip";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { latestInstant, lastSessionLabel, PriceStamps, type PriceTime, type StampOptions } from "../Freshness";
import { formatPercent, formatPp } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import "./OverviewHero.scss";

export interface OverviewHeroProps {
  /** Undefined while loading. */
  data: OverviewDto | undefined;
  currency: ReportingCurrency;
  loading: boolean;
  /** Injected clock (tests). */
  now?: Date;
  /** Desktop right zone (the intraday mini chart); hidden below the desktop breakpoint. */
  aside?: ReactNode;
}

const SPLIT_TIP =
  "Since you started. Investment: the return of your holdings in the currency they trade in (mostly USD). " +
  "Currency: how much the EUR/USD exchange rate added (+) or took away (−) from your EUR return, in percentage points.";

const OVERNIGHT_TIP =
  "US markets are shut, so your dollar holdings stand still at the last close. This is how much the " +
  "EUR/USD rate has changed their value since that close. Last session's move plus this is the total change since the previous close.";

function moveTip(ccy: string, ccy2: string, closed: boolean, lastSession: boolean): string {
  return (
    `The change since the previous close, in ${ccy}. ${ccy2}: the same change measured in ${ccy2}, ` +
    `so the gap between the two is the exchange-rate effect.` +
    (lastSession
      ? ` The market has not traded yet today, so this is the last session's result.`
      : closed
        ? ` US markets are closed now, so dollar prices stand still and only the exchange rate moves.`
        : "")
  );
}

/** "Today" for today's move, else "Last session · Tue" (days in the Settings timezone). */
export function dayMoveLabel(asOf: string | null | undefined, opts: StampOptions = {}): string {
  return lastSessionLabel(asOf, opts) ?? "Today";
}

/** When the headline prices are from: the exchange time, a live pull, else the session close. */
export function heroPriceTime(data: OverviewDto): PriceTime {
  const f = data.freshness;
  const open = f?.market_state === "open";
  return {
    instant: f?.price_market_at ?? (open ? f?.price_observed_at : null) ?? null,
    date: data.kpis.daily_growth_as_of ?? null,
    marketOpen: open,
  };
}

/**
 * Headline: total value in both currencies and the day's move, labelled
 * "Today" or "Last session · Tue", with when the prices are from and when the
 * app last fetched them, plus the investment-vs-currency return split.
 */
export function OverviewHero({ data, currency, loading, now, aside }: OverviewHeroProps) {
  const timeZone = useTimeZone();
  const side = aside ? <div className="overview-hero__aside">{aside}</div> : null;
  const cls = clsx("overview-hero", side && "overview-hero--split");
  if (loading || !data) {
    return (
      <section className={cls} aria-label="Portfolio value">
        <div className="overview-hero__main">
          <Skeleton height="1rem" width="30%" />
          <Skeleton height="2.5rem" width="55%" />
          <Skeleton height="1rem" width="40%" />
        </div>
        {side}
      </section>
    );
  }
  const opts = { timeZone, now };
  const k = data.kpis;
  const k2 = data.kpis_secondary;
  const live = data.daily_caption?.live ?? false;
  const split = data.currency.return_split;
  const ccy2 = data.secondary_ccy;
  const f = data.freshness;
  const marketClosed = f?.market_state !== "open";
  const dayLabel = dayMoveLabel(k.daily_growth_as_of, opts);
  const lastSession = dayLabel !== "Today";
  // While US markets are shut the dollar value cannot move: say so instead of "0.00%".
  const usdFlat = marketClosed && !lastSession && toNum(k2?.daily_growth_pct ?? null) === 0;
  // Market shut: the headline move is the last session's; the EUR/USD change since
  // its 16:00 close is a separate line, so the two are never blended.
  const overnight = data.last_session ? toNum(data.last_session.overnight_currency) : null;
  const fetched = f ? latestInstant(f.last_price_update_at, f.price_observed_at) : null;
  return (
    <section className={cls} aria-label="Portfolio value">
      <div className="overview-hero__main">
        <div className="overview-hero__head">
          <span className="overview-hero__label">Portfolio value</span>
          {live && (
            <span className="overview-hero__corner overview-hero__corner--live">
              <span className="overview-hero__dot" aria-hidden />
              Live
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
          <span className={clsx("overview-hero__day", lastSession && "overview-hero__day--last")}>{dayLabel}</span>
          {k2?.daily_growth_pct != null && (
            <span className="overview-hero__muted overview-hero__usd">
              {usdFlat ? (
                `${ccy2} unchanged`
              ) : (
                <span>
                  {ccy2} <Percent ratio={toNum(k2.daily_growth_pct)} signed />
                </span>
              )}
              <InfoTip label="today's move" content={moveTip(currency, ccy2, marketClosed, lastSession)} />
            </span>
          )}
        </div>
        {overnight !== null && (
          <p className="overview-hero__overnight" data-testid="overnight-currency">
            <span className="overview-hero__muted">Overnight currency</span>
            <Money amount={overnight} currency={currency} signed colored />
            <InfoTip label="overnight currency" content={OVERNIGHT_TIP} />
          </p>
        )}
        <PriceStamps className="overview-hero__stamps" price={heroPriceTime(data)} updated={fetched} options={opts} />
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
      </div>
      {side}
    </section>
  );
}
