import clsx from "clsx";
import type { ReactNode } from "react";
import { DeltaBadge } from "../DeltaBadge";
import { InfoTip } from "../InfoTip";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { latestInstant, lastSessionLabel, PriceStamps, type PriceTime, type StampOptions } from "../Freshness";
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



type EstimateDto = NonNullable<OverviewDto["kpis"]["estimate"]>;

/** What the "≈" chip explains: which funds stand in for their ETF twin and by how much the total moves. */
function EstimateTip({ est, official, currency }: { est: EstimateDto; official: number | null; currency: string }) {
  return (
    <span className="overview-hero__est-tip" data-testid="hero-estimate-tip">
      <span>
        Some mutual funds have not published today&apos;s NAV yet. Until they do, each is valued from its ETF twin&apos;s live
        price, so this total is an estimate.
      </span>
      <ul className="overview-hero__est-list">
        {est.funds.map((f) => (
          <li key={f.symbol}>
            {f.symbol} ≈ {f.twin}
          </li>
        ))}
      </ul>
      <span>
        Official total (funds at their last NAV): <Money amount={official} currency={currency} />
      </span>
      <span>
        Estimate adjustment: <Money amount={toNum(est.adjustment)} currency={currency} signed />
      </span>
    </span>
  );
}

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
  const ccy2 = data.secondary_ccy;
  const f = data.freshness;
  const marketClosed = f?.market_state !== "open";
  const secPct = k2?.estimate ? k2.estimate.daily_growth_pct : k2?.daily_growth_pct;
  const dayLabel = dayMoveLabel(k.daily_growth_as_of, opts);
  const lastSession = dayLabel !== "Today";
  // While US markets are shut the dollar value cannot move: say so instead of "0.00%".
  const usdFlat = marketClosed && !lastSession && toNum(secPct ?? null) === 0;
  // Market shut: the headline move is the last session's; the EUR/USD change since
  // its 16:00 close is a separate line, so the two are never blended.
  const est = k.estimate ?? null;
  const est2 = k2?.estimate ?? null;
  // Estimating: the headline is the estimated book. The official total and the
  // day's price/FX split now sit in the KPI block below (see `KpiGrid/DayFacts`).
  const headTotal = est ? est.total_value : k.total_value;
  const headMove = est ? est.daily_move : k.daily_move;
  const headPct = est ? est.daily_growth_pct : k.daily_growth_pct;
  // The small official line: shut market, the official change since the previous close includes
  // the overnight currency (last_session.day_move); open market, the plain official day move.
  // Its change is given as money and percent together, since "how far off is the estimate"
  // is a money question; both stay uncoloured so the line reads as context, not a second headline.
  const secTotal = est2 ? est2.total_value : k2?.total_value;
  const ls = data.last_session ?? null;
  // The official book, beside the headline because that is the number that is real:
  // the estimate is only ever a stand-in for it. Shut market, the official change
  // since the previous close already folds in the overnight currency; open market,
  // the plain official day move.
  const offShut = marketClosed && ls?.day_move != null;
  const officialPct = offShut ? ls?.day_move_pct : k.daily_growth_pct;
  const officialMove = offShut ? ls?.day_move : k.daily_move;
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
        {/*
          The headline band: the value and the day's move side by side, so the two
          things asked first are answered on one line and the desktop's width is used
          rather than padded. Below the breakpoint they stack.
        */}
        {/*
          v5's shape, deliberately: the figure, the other currency beneath it, and one
          coloured change badge — nothing else. The supporting numbers that used to
          crowd this card (the official total, the day's price/FX split, the lifetime
          growth split) now sit in the KPI block directly below, which is where every
          other figure on this page already lives. The card reads the same in every
          market state, so nothing shifts under you as the day goes on.
        */}
        <div className="overview-hero__values">
          <span className="overview-hero__headline">
            <span className="overview-hero__value">
              <Money amount={toNum(headTotal)} currency={currency} />
            </span>
            {est && (
              <span className="overview-hero__est-chip" data-testid="hero-estimate-chip">
                ≈ est.
                <InfoTip
                  label="the estimated total"
                  content={<EstimateTip est={est} official={toNum(k.total_value)} currency={currency} />}
                />
              </span>
            )}
          </span>
          {k2 && (
            <span className="overview-hero__value2">
              <Money amount={toNum(secTotal ?? null)} currency={ccy2} />
            </span>
          )}
        </div>
        {est && (
          <p className="overview-hero__official" data-testid="hero-official">
            <span className="overview-hero__muted">Official</span>
            <Money amount={toNum(k.total_value)} currency={currency} />
            <span className="overview-hero__official-change" data-testid="hero-official-change">
              <Money amount={toNum(officialMove ?? null)} currency={currency} signed />
              {" · "}
              <Percent ratio={toNum(officialPct ?? null)} signed />
            </span>
          </p>
        )}
        {/*
          The change row and the price time share a line when there is room for both,
          and the stamps fall to their own line when there is not — flex wrap decides
          from the actual content, so no width has to be guessed. `space-between`
          holds the stamps right while they share the line and lets them sit at the
          left edge once they wrap, which is where they read best on a phone.
        */}
        <div className="overview-hero__line">
          <div className="overview-hero__move">
            <DeltaBadge value={toNum(headPct)} />
            <Money amount={toNum(headMove)} currency={currency} signed colored />
            <span className={clsx("overview-hero__day", lastSession && "overview-hero__day--last")}>{dayLabel}</span>
            {secPct != null && (
              <span className="overview-hero__muted overview-hero__usd">
                {usdFlat ? (
                  `${ccy2} unchanged`
                ) : (
                  <span>
                    {ccy2} <Percent ratio={toNum(secPct)} signed />
                  </span>
                )}
                <InfoTip label="today's move" content={moveTip(currency, ccy2, marketClosed, lastSession)} />
              </span>
            )}
          </div>
          <PriceStamps
            className="overview-hero__stamps"
            price={heroPriceTime(data)}
            updated={fetched}
            compact
            options={opts}
          />
        </div>
        {data.total_value_complete === false && (
          <p className="overview-hero__note">Some holdings have no live price yet; the total is incomplete.</p>
        )}
      </div>
      {side}
    </section>
  );
}
