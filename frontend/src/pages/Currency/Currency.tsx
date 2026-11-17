import { ArrowDownRight, ArrowUpRight, Euro, Minus } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Card } from "../../components/Card";
import { CurrencyBox } from "../../components/CurrencyBox";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { StatStrip, type StatItem } from "../../components/StatStrip";
import { formatDate, formatNumber, formatPp } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { toNum, useOverview } from "../../lib/queries/portfolio";
import { useCurrency, type CurrencyDto, type CurrencyStatDto } from "../../lib/queries/currency";
import { useShellStatus } from "../../lib/shell";
import "./Currency.scss";

const VIEWS = [{ value: "today", label: "Today" }] as const;
type View = (typeof VIEWS)[number]["value"];
const isView = (v: string | null): v is View => VIEWS.some((o) => o.value === v);

const LABELS: Record<string, { label: string; tip: string; noteLead?: string }> = {
  rate_now: { label: "EUR/USD now", tip: "How many dollars one euro buys at the latest rate." },
  effect_today: {
    label: "Currency effect today",
    tip: "What the exchange rate added to or took from your portfolio value since the last close.",
  },
  investing_power_today: {
    label: "Investing power today",
    tip: "How many more or fewer dollars your regular euro amount buys than at the last close.",
  },
  lifetime_effect: {
    label: "Currency effect, lifetime",
    tip: "What exchange-rate moves have added to or taken from your result since you started.",
  },
  avg_rate_vs_now: {
    label: "Your average rate",
    tip: "The average rate at which your euros became dollars, with today's rate beside it.",
    noteLead: "now",
  },
  one_cent: {
    label: "One cent of EUR/USD",
    tip: "What a one cent move in the rate is worth on your holdings.",
    noteLead: "at",
  },
};

const KIND_WORD = { tailwind: "Tailwind", headwind: "Headwind", neutral: "Neutral" } as const;
const KIND_ICON = { tailwind: ArrowUpRight, headwind: ArrowDownRight, neutral: Minus } as const;

function figure(unit: string | null | undefined, value: string | null | undefined, ccy: string | null | undefined, fallbackCcy: string): ReactNode {
  const n = toNum(value ?? null);
  if (unit === "rate") return formatNumber(n, 4);
  if (unit === "fraction") return formatPp(n);
  return <Money amount={n} currency={ccy ?? fallbackCcy} signed colored />;
}

function statItem(s: CurrencyStatDto, fallbackCcy: string): StatItem {
  const meta = LABELS[s.key] ?? { label: s.key, tip: "" };
  const kind = s.kind ?? null;
  const Icon = kind ? KIND_ICON[kind] : null;
  const secondary = s.secondary
    ? figure(s.secondary_unit, s.secondary, s.secondary_currency ?? s.currency, fallbackCcy)
    : null;
  const hasNote = Boolean(kind || secondary);
  return {
    key: s.key,
    label: meta.label,
    tip: meta.tip || undefined,
    value: figure(s.unit, s.value, s.currency, fallbackCcy),
    note: hasNote ? (
      <span className="currency-page__note">
        {kind && Icon ? (
          <span className={`currency-page__kind currency-page__kind--${kind}`}>
            <Icon aria-hidden className="currency-page__kind-icon" />
            {KIND_WORD[kind]}
          </span>
        ) : null}
        {secondary ? (
          <span>
            {meta.noteLead ? `${meta.noteLead} ` : ""}
            {secondary}
          </span>
        ) : null}
      </span>
    ) : undefined,
  };
}

/** The Today figures under the box: the day's rate range and what the regular amount buys. */
function TodayFigures({ cur }: { cur: CurrencyDto }) {
  const { rate_range: range, buys } = cur;
  if (!range && !buys) return null;
  return (
    <Card className="currency-page__figures" title="Today in numbers">
      <dl className="currency-page__rows">
        {range ? (
          <div className="currency-page__row" data-testid="today-range">
            <dt className="currency-page__row-label">Today's range{cur.today.pair ? ` (${cur.today.pair})` : ""}</dt>
            <dd className="currency-page__row-value">
              {range.low_display} to {range.high_display}
            </dd>
          </div>
        ) : null}
        {buys ? (
          <div className="currency-page__row" data-testid="today-buys">
            <dt className="currency-page__row-label">
              <Euro aria-hidden className="currency-page__row-icon" />
              {formatNumber(toNum(buys.amount_eur), 0)} euros buy
            </dt>
            <dd className="currency-page__row-value">
              <Money amount={toNum(buys.usd_now)} currency="USD" /> now
              {buys.usd_prev ? (
                <>
                  {" · yesterday "}
                  <Money amount={toNum(buys.usd_prev)} currency="USD" />
                </>
              ) : null}
              {buys.change_usd ? (
                <>
                  {" · "}
                  <Money amount={toNum(buys.change_usd)} currency="USD" signed colored />
                </>
              ) : null}
              {buys.market_hours_usd != null && buys.overnight_usd != null ? (
                <span className="currency-page__split">
                  market hours <Money amount={toNum(buys.market_hours_usd)} currency="USD" signed colored />
                  {" · overnight "}
                  <Money amount={toNum(buys.overnight_usd)} currency="USD" signed colored />
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

export function Currency() {
  const { currency } = usePrefs();
  const q = useCurrency(currency);
  const overview = useOverview(currency);
  const [params, setParams] = useSearchParams();
  const rawView = params.get("view");
  const view: View = isView(rawView) ? rawView : "today";
  const setView = (v: View) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "today") next.delete("view");
        else next.set("view", v);
        return next;
      },
      { replace: true },
    );

  const { refetch: qRefetch } = q;
  const refetch = useCallback(() => void qRefetch(), [qRefetch]);
  useShellStatus(
    q.isError ? "stale" : q.isPending ? "loading" : "closed",
    q.data ? `As of ${formatDate(q.data.as_of)}` : "Loading",
    refetch,
    q.isFetching,
  );

  const cur = q.data;
  const stats = cur?.stats ?? [];
  const noData = cur && stats.length === 0 && !cur.buys && !cur.rate_range && !cur.today.spot;

  return (
    <div className="currency-page">
      <PageHeader title="Currency" subtitle={cur ? `As of ${formatDate(cur.as_of)}` : undefined} />
      {q.isError && !cur ? (
        <ErrorState title="Currency could not be loaded" onRetry={refetch} />
      ) : !cur ? (
        <div className="currency-page__stack" aria-busy="true">
          <Skeleton height="6rem" />
          <Skeleton height="14rem" />
        </div>
      ) : noData ? (
        <EmptyState
          icon={<Euro aria-hidden />}
          title="No currency data yet"
          description="Once there are rates and holdings, the effect of the euro and dollar shows up here."
        />
      ) : (
        <div className="currency-page__stack">
          {stats.length > 0 ? (
            <StatStrip label="Currency at a glance" items={stats.map((s) => statItem(s, cur.ccy))} />
          ) : null}
          <SegmentedControl block ariaLabel="Currency views" options={[...VIEWS]} value={view} onChange={setView} />
          {view === "today" ? (
            <div className="currency-page__panel">
              <CurrencyBox
                data={{ ccy: cur.ccy, currency: { today: cur.today }, kpis: { total_value: overview.data?.kpis?.total_value } }}
                collapsibleId="currency.today"
              />
              <TodayFigures cur={cur} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

