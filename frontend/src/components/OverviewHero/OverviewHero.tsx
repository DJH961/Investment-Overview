import clsx from "clsx";
import { useRef, type ReactNode } from "react";
import { Moon } from "lucide-react";
import { DaySplit } from "../DaySplit";
import { DeltaBadge } from "../DeltaBadge";
import { InfoTip } from "../InfoTip";
import { useFitWidth } from "../KpiTile/useFitWidth";
import { Money } from "../Money";
import { MarketChip, MarketClock, type ClockFreshness } from "../MarketClock";
import { JUST_CLOSED, useBlip, useMarketPhase, usePrevious } from "../MarketClock/marketPhase";
import { parseInstant } from "../../lib/format";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { latestInstant, lastSessionLabel, PriceStamps, type PriceTime, type StampOptions } from "../Freshness";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import { useHideAmounts } from "../../lib/hideAmounts";
import "./OverviewHero.scss";

export interface OverviewHeroProps {
  /** Undefined while loading. */
  data: OverviewDto | undefined;
  currency: ReportingCurrency;
  loading: boolean;
  /** Injected clock (tests). */
  now?: Date;
  /**
   * The "Today" stat block: under the move on phones, a right column on desktop. As a
   * function it receives the market clock and places it (in the slot the intraday
   * sparkline used to fill); a plain node gets the clock above it.
   */
  aside?: ReactNode | ((clock: ReactNode) => ReactNode);
  /** The market clock reached its open / close: fetch the server's next instants. */
  onClockBoundary?: () => void;
  /** Set inside the Overview stage: no surface of its own, the stage draws it. */
  embedded?: boolean;
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
    `Change since the previous close, in ${ccy}. ${ccy2}: the same change in ${ccy2}; the gap is the currency.` +
    (lastSession ? " No trading yet today: this is the last session." : closed ? " Market closed: only the currency moves now." : "")
  );
}

/**
 * The hero's corner word for the US session, from the bell to the first tick:
 * "Live" (a dot that pulses once when the open's first tick lands), "Closing…" while the
 * close is settling, "Closed" for an hour after it, "Opening" until the first tick.
 * Nothing otherwise (the clock says the rest). A word every time, never colour alone.
 */
export function HeroMarketCorner({ freshness, live, now }: { freshness: ClockFreshness | null | undefined; live: boolean; now?: Date }) {
  const { phase, now: at } = useMarketPhase(freshness, live, now);
  const prev = usePrevious(phase);
  const pulse = useBlip(phase === "live" && prev === "opening", 1400);
  if (!phase || !freshness) return null;
  const closedAt = freshness.last_close_at ? parseInstant(freshness.last_close_at).getTime() : Number.NaN;
  const justClosed = phase === "closed" && (prev === "closing" || (at.getTime() >= closedAt && at.getTime() - closedAt < JUST_CLOSED));
  const word = phase === "live" ? "Live" : phase === "closing" ? "Closing…" : phase === "opening" ? "Opening" : justClosed ? "Closed" : null;
  if (!word) return null;
  return (
    <span
      className={clsx("overview-hero__corner", `overview-hero__corner--${phase}`, pulse && "overview-hero__corner--pulse")}
      data-testid="hero-market-corner"
    >
      <span className="overview-hero__dot" aria-hidden />
      {word}
    </span>
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
export function OverviewHero({ data, currency, loading, now, aside, onClockBoundary, embedded = false }: OverviewHeroProps) {
  const timeZone = useTimeZone();
  const { hide } = useHideAmounts();
  // The big figure shrinks to fit the card (seven-figure USD / de-DE values at 360 px).
  const valuesRef = useRef<HTMLDivElement>(null);
  useFitWidth(valuesRef, loading || !data);
  // Phones: no standing clock band. A quiet chip in the corner opens the full clock; the
  // compact band shows by itself only in the last 15 minutes to a bell (and 5 after).
  const phone = useMediaQuery("(max-width: 767px)");
  const clock =
    data && !loading ? (
      <MarketClock freshness={data.freshness} now={now} onBoundary={onClockBoundary} variant={phone ? "near" : "full"} />
    ) : null;
  const asideNode =
    typeof aside === "function" ? aside(clock) : aside ? (
      <>
        {clock}
        {aside}
      </>
    ) : null;
  const side = asideNode ? <div className="overview-hero__aside">{asideNode}</div> : null;
  const cls = clsx("overview-hero", side && "overview-hero--split", embedded && "overview-hero--embedded");
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
  // Market open (no last_session): last night's currency move is inside today's total;
  // the hero names it once (it used to sit under the Day move tile as well). Euro view
  // only: a book reported in its own currency has no currency leg. Hide mode: the move
  // as a share of the value it applies to (both server figures, one payload).
  const fxMove = !ls && currency === "EUR" && data.day_split ? toNum(data.day_split.currency_move) : null;
  const fxShown = fxMove !== null && Math.abs(fxMove) >= 0.005;
  const fxTotal = toNum(k.total_value);
  const fxShare = fxMove !== null && fxTotal ? fxMove / fxTotal : null;
  const fetched = f ? latestInstant(f.last_price_update_at, f.price_observed_at) : null;
  return (
    <section className={cls} aria-label="Portfolio value">
      <div className="overview-hero__main">
        <div className={clsx("overview-hero__head", est && "overview-hero__head--est")}>
          {/* The "≈ est." chip sits with the label, never competing with the figure's width. */}
          <span className="overview-hero__label-line">
            <span className="overview-hero__label">Portfolio value</span>
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
          {phone && f ? (
            <MarketChip freshness={f} live={live} currency={currency} now={now} />
          ) : (
            <HeroMarketCorner freshness={f} live={live} now={now} />
          )}
        </div>
        <div className="overview-hero__values" ref={valuesRef}>
          <span className="overview-hero__headline">
            <span className="overview-hero__value">
              <Money amount={toNum(headTotal)} currency={currency} />
            </span>
          </span>
          {/* The other currency and the price time share one line. */}
          <span className="overview-hero__sub">
            {k2 && (
              <span className="overview-hero__value2">
                <Money amount={toNum(secTotal ?? null)} currency={ccy2} />
              </span>
            )}
            <PriceStamps
              className="overview-hero__stamps"
              price={heroPriceTime(data)}
              updated={fetched}
              compact
              options={opts}
            />
          </span>
        </div>
        {/*
          Everything under the big value on ONE wrapping row, using the full width:
          the day's move (badge, money, day pill), its ☀ + ☾ split, the overnight FX,
          the official book while estimating, and the other currency's move pushed to
          the right edge. Flex wrap decides from the real content where a phone breaks
          the row. The row's height is reserved in every view, so switching EUR/USD
          (USD has no currency leg) never moves the page.
        */}
        <div className="overview-hero__facts">
          <div className="overview-hero__move">
            <DeltaBadge value={toNum(headPct)} />
            <Money amount={toNum(headMove)} currency={currency} signed colored />
            <span className={clsx("overview-hero__day", lastSession && "overview-hero__day--last")}>{dayLabel}</span>
          </div>
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
          {ls && (
            <DaySplit
              sessionPct={toNum(ls.move_pct ?? null)}
              overnightPct={toNum(ls.overnight_pct ?? null)}
              overnight={toNum(ls.overnight_currency)}
              estimate={est !== null}
              currency={currency}
              marketOpen={ls.market_open}
              data-testid="hero-day-split"
            />
          )}
          {fxShown && (
            <span className="overview-hero__fx" data-testid="overnight-currency">
              <Moon className="overview-hero__fx-icon" aria-hidden />
              {data.day_split?.overnight ? "Overnight FX" : "FX since close"}{" "}
              {hide && fxShare !== null ? (
                <Percent ratio={fxShare} signed colored />
              ) : (
                <Money amount={fxMove} currency={currency} signed colored />
              )}
              <span className="overview-hero__muted">in today&apos;s total</span>
            </span>
          )}
          {est && (
            <p className="overview-hero__official" data-testid="hero-official">
              <span className="overview-hero__muted">Official</span>
              <Money amount={toNum(k.total_value)} currency={currency} />
              <span className="overview-hero__official-change" data-testid="hero-official-change">
                <span className="overview-hero__official-money">
                  <Money amount={toNum(officialMove ?? null)} currency={currency} signed />
                  {" · "}
                </span>
                <Percent ratio={toNum(officialPct ?? null)} signed />
              </span>
            </p>
          )}
        </div>
        {data.total_value_complete === false && (
          <p className="overview-hero__note">Some holdings have no live price yet; the total is incomplete.</p>
        )}
        {!aside && clock}
      </div>
      {side}
    </section>
  );
}
