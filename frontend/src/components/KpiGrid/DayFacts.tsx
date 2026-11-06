import type { ReactNode } from "react";
import { InfoTip } from "../InfoTip";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";

export const OVERNIGHT_TIP =
  "US markets are shut, so your dollar holdings stand still at the last close. This is how much the " +
  "EUR/USD rate has changed their value since that close. The price move plus this is the total change since the previous close.";

const OFFICIAL_TIP =
  "The total with every fund at its last published NAV, and how that total changed. The headline above " +
  "replaces the pending funds with their ETF twin's estimate, so the gap between the two is the estimate.";

const PRICE_MOVE_TIP =
  "What your holdings' prices did across the last session, each valued at that session's own exchange rate. " +
  "Add the overnight FX figure beside it and you get the headline change exactly.";

/**
 * One labelled fact: a small key, a figure, and optionally a quieter second
 * figure under it. A key over a figure can be scanned; the prose line each of
 * these used to be had to be read.
 */
function Fact({
  label,
  value,
  sub,
  tip,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tip?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="kpi-grid__fact" data-testid={testId}>
      <dt className="kpi-grid__fact-key">
        {label}
        {tip}
      </dt>
      <dd className="kpi-grid__fact-value">
        {value}
        {sub && <span className="kpi-grid__fact-sub">{sub}</span>}
      </dd>
    </div>
  );
}

/**
 * Today's figures that explain the headline, directly under it: the official
 * total while a twin estimates the book, and the split of the day's change into
 * what prices did and what the exchange rate did.
 *
 * These used to crowd the hero card. They live here because this is the block
 * that already carries every other figure on the page, and because only some of
 * them exist at any moment — a hero that grew and shrank with the market's state
 * moved its own contents around as the day went on.
 */
export function DayFacts({ data, currency }: { data: OverviewDto | undefined; currency: ReportingCurrency }) {
  if (!data) return null;
  const k = data.kpis;
  const est = k.estimate ?? null;
  const ls = data.last_session ?? null;
  const marketClosed = data.freshness?.market_state !== "open";
  const overnight = ls
    ? toNum(est && ls.overnight_currency_est != null ? ls.overnight_currency_est : ls.overnight_currency)
    : null;
  // Shut market: the official change since the previous close already folds in the
  // overnight currency. Open market: the plain official day move.
  const offShut = marketClosed && ls?.day_move != null;
  const officialPct = offShut ? ls?.day_move_pct : k.daily_growth_pct;
  const officialMove = offShut ? ls?.day_move : k.daily_move;
  const lastEst = est && ls && ls.move_est != null ? ls : null;
  // A reporting currency that is also the holdings' currency cannot drift overnight:
  // the figure is a constant zero, so it is left out rather than printed as noise.
  const fx = overnight !== null && Math.abs(overnight) >= 0.005 ? overnight : null;

  const facts = [
    est ? (
      <Fact
        key="official"
        label="Official"
        testId="hero-official"
        tip={<InfoTip label="the official total" content={OFFICIAL_TIP} />}
        value={<Money amount={toNum(k.total_value)} currency={currency} />}
        sub={
          <span data-testid="hero-official-change">
            <Money amount={toNum(officialMove ?? null)} currency={currency} signed />
            {" · "}
            <Percent ratio={toNum(officialPct ?? null)} signed />
          </span>
        }
      />
    ) : null,
    lastEst && fx !== null ? (
      <Fact
        key="price-move"
        label="Price move"
        testId="last-session-est"
        tip={<InfoTip label="the day's price move" content={PRICE_MOVE_TIP} />}
        value={<Money amount={toNum(lastEst.move_est ?? null)} currency={currency} signed colored />}
      />
    ) : null,
    fx !== null ? (
      <Fact
        key="overnight"
        label="Overnight FX"
        testId="overnight-currency"
        tip={<InfoTip label="the overnight currency move" content={OVERNIGHT_TIP} />}
        value={<Money amount={fx} currency={currency} signed colored />}
      />
    ) : null,
  ].filter((f) => f !== null);

  if (facts.length === 0) return null;
  return (
    <dl className="kpi-grid__facts" aria-label="Today's figures">
      {facts}
    </dl>
  );
}
