import { ArrowDownRight, ArrowUpRight, Euro, Minus } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { RateChart } from "../../components/RateChart";
import { Skeleton } from "../../components/Skeleton";
import { StatStrip, type StatItem } from "../../components/StatStrip";
import { formatDate, formatNumber, formatPp } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { toNum } from "../../lib/queries/portfolio";
import { useCurrency, type CurrencyStatDto } from "../../lib/queries/currency";
import { useShellStatus } from "../../lib/shell";
import "./Currency.scss";

const LABELS: Record<string, { label: string; tip: string; noteLead?: string }> = {
  rate_now: { label: "EUR/USD now", tip: "How many dollars one euro buys at the latest rate." },
  effect_today: {
    label: "Effect today",
    tip: "What the exchange rate added to or took from your portfolio value since the last close.",
  },
  investing_power_today: {
    label: "Investing power today",
    tip: "How many more or fewer dollars your regular euro amount buys than at the last close.",
  },
  lifetime_effect: {
    label: "Effect, lifetime",
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
  // Whole units: cents on a currency effect are noise (and crowd a phone row).
  return <Money amount={n} currency={ccy ?? fallbackCcy} signed colored digits={0} />;
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

export function Currency() {
  const { currency } = usePrefs();
  const q = useCurrency(currency);

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
          {/* The page leads with the rate; the strip follows. Today's split stays on the
              Overview's Currency card: this page shows only views the Overview has not. */}
          <RateChart currency={currency} />
          {stats.length > 0 ? (
            <StatStrip
              className="stat-strip--rows"
              label="Currency at a glance"
              // The rate and your average are on the chart above, in its quote.
              items={stats.filter((s) => s.key !== "rate_now" && s.key !== "avg_rate_vs_now").map((s) => statItem(s, cur.ccy))}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

