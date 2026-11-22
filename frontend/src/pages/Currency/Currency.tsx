import { ChevronLeft, Euro } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { CurrencySectionSlot, serverStatItem, type StatMeta } from "../../components/CurrencySection";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { PageHeader } from "../../components/PageHeader";
import { RateChart } from "../../components/RateChart";
import { RangePicker, SectionBar } from "../../components/SectionBar";

import { Skeleton } from "../../components/Skeleton";
import { StatStrip } from "../../components/StatStrip";
import { formatDate } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { useCurrency } from "../../lib/queries/currency";
import { RATE_RANGE_LABELS, RATE_RANGES, type RateRange } from "../../lib/queries/currencyRate";
import { useShellStatus } from "../../lib/shell";
import { CurrencyRangeContext, useCurrencyRangeState, type CurrencyRangeState } from "./range";
import { CURRENCY_SECTIONS, findSubPage, type CurrencySectionDef, type CurrencySubPage } from "./sections";
import "./Currency.scss";

/** The always-visible strip's words. The server sends the figures (`/api/currency/both` stats). */
export const STRIP_LABELS: Record<string, StatMeta> = {
  rate_now: { label: "EUR/USD now", tip: "How many dollars one euro buys at the latest rate." },
  effect_today: {
    label: "Effect today",
    tip: "What the exchange rate added to or took from your portfolio value since the last close.",
  },
  effect_ytd: {
    label: "Effect this year",
    tip: "What exchange-rate moves added to or took from your portfolio since 1 January, with the gap between your euro and dollar returns.",
  },
  investing_power_today: {
    label: "Investing power today",
    tip: "How many more or fewer dollars your regular euro amount buys than at the last close.",
  },
  lifetime_effect: {
    label: "Effect, lifetime",
    tip: "What exchange-rate moves have added to or taken from your result since you started.",
  },
  effect_this_year: {
    label: "Effect this year",
    tip: "What the exchange rate added to or took from your portfolio this year, in money and percentage points.",
  },
  effect_lifetime: {
    label: "Effect, lifetime",
    tip: "What the exchange rate added to or took from your portfolio since you started, in money and percentage points.",
  },
  dollar_trend: {
    label: "Dollar trend",
    tip: "Whether the dollar is above or below its 200-day average, and whether this month's move is a usual one. It describes; it does not predict.",
    fractionFormat: "percent",
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

/**
 * On the chart already (rate, average, dollar trend), in What if (one cent) or about the
 * next conversion rather than your holdings (investing power, the Overview's Today card):
 * never twice. Both views keep the same three tiles: today, this year, lifetime.
 */
const NOT_IN_STRIP = new Set(["rate_now", "avg_rate_vs_now", "lifetime_effect", "dollar_trend", "one_cent", "investing_power_today"]);
/** Today, this year, lifetime: the strip reads left to right from short to long. */
const STRIP_ORDER = ["effect_today", "effect_this_year", "effect_ytd", "effect_lifetime"];
const stripRank = (key: string) => {
  const i = STRIP_ORDER.indexOf(key);
  return i < 0 ? STRIP_ORDER.length : i;
};

const RANGE_OPTIONS = RATE_RANGES.map((r) => ({
  value: r,
  label: RATE_RANGE_LABELS[r],
  hint: r === "all" ? "All, since you started" : r === "max" ? "Max, since 1999" : undefined,
}));

/** The page range picker: in the sticky section bar, so it is in reach from every section. */
function PageRangePicker({ range }: { range: CurrencyRangeState }) {
  return (
    <RangePicker
      label="Range"
      options={RANGE_OPTIONS}
      value={range.range}
      emphasis="all"
      onChange={(r) => range.setRange(r as RateRange)}
    />
  );
}

export function Currency() {
  const { sub } = useParams();
  const rangeState = useCurrencyRangeState();
  const found = findSubPage(sub);
  if (sub && !found) return <Navigate to="/currency" replace />;
  return (
    <CurrencyRangeContext.Provider value={rangeState}>
      {found ? <CurrencySubPageView section={found.section} page={found.page} range={rangeState} /> : <CurrencyMain range={rangeState} />}
    </CurrencyRangeContext.Provider>
  );
}

function CurrencyMain({ range }: { range: CurrencyRangeState }) {
  const { currency } = usePrefs();
  const q = useCurrency(currency);
  const location = useLocation();

  const { refetch: qRefetch } = q;
  const refetch = useCallback(() => void qRefetch(), [qRefetch]);
  useShellStatus(
    q.isError ? "stale" : q.isPending ? "loading" : "closed",
    q.data ? `As of ${formatDate(q.data.as_of)}` : "Loading",
    refetch,
    q.isFetching,
  );

  // Sections mount as they scroll near; a jump mounts every one up to its target, so the
  // target's title lands where it should and does not move as the ones above load.
  const [forcedUpTo, setForcedUpTo] = useState(-1);
  const forceUpTo = useCallback((id: string) => {
    const i = CURRENCY_SECTIONS.findIndex((s) => s.id === id);
    setForcedUpTo((cur) => Math.max(cur, i));
  }, []);
  // A link to /currency#exposure lands on its section (mounted with every one above it).
  const hash = location.hash.replace(/^#/, "");
  const hashIndex = CURRENCY_SECTIONS.findIndex((s) => s.id === hash);
  const forcedIndex = Math.max(forcedUpTo, hashIndex);
  const cur = q.data;
  const ready = Boolean(cur);
  useEffect(() => {
    if (!ready || hashIndex < 0) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView?.({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [ready, hash, hashIndex]);

  const stats = cur?.stats ?? [];
  const noData = cur && stats.length === 0 && !cur.buys && !cur.rate_range && !cur.today.spot;
  const items = useMemo(() => CURRENCY_SECTIONS.map(({ id, label }) => ({ id, label })), []);

  return (
    <div className="currency-page">
      <PageHeader title="Currency" subtitle={cur ? `As of ${formatDate(cur.as_of)}` : undefined} />
      {q.isError && !cur ? (
        <ErrorState title="Currency could not be loaded" onRetry={refetch} />
      ) : !cur ? (
        <div className="currency-page__stack" aria-busy="true">
          <Skeleton height="20rem" />
          <Skeleton height="6rem" />
        </div>
      ) : noData ? (
        <EmptyState
          icon={<Euro aria-hidden />}
          title="No currency data yet"
          description="Once there are rates and holdings, the effect of the euro and dollar shows up here."
        />
      ) : (
        <div className="currency-page__stack">
          <SectionBar items={items} label="Currency sections" onSelect={forceUpTo} extra={<PageRangePicker range={range} />} />
          {/* The page leads with the rate; the strip follows. Today's split stays on the
              Overview's Currency card: this page shows only views the Overview has not.
              The range picker is in the sticky bar above, so the chart hides its own. */}
          <RateChart currency={currency} range={range.range} onRangeChange={range.setRange} showRangePicker={false} />
          {stats.length > 0 ? (
            <StatStrip
              className="stat-strip--rows"
              label="Currency at a glance"
              items={stats
                .filter((s) => !NOT_IN_STRIP.has(s.key))
                .sort((a, b) => stripRank(a.key) - stripRank(b.key))
                .map((s) => serverStatItem(s, STRIP_LABELS[s.key], cur.ccy))}
            />
          ) : null}
          {CURRENCY_SECTIONS.map((s, i) => (
            <CurrencySectionSlot key={s.id} id={s.id} label={s.label} force={i <= forcedIndex}>
              {() => <s.Component id={s.id} label={s.label} currency={currency} range={range.range} />}
            </CurrencySectionSlot>
          ))}
        </div>
      )}
    </div>
  );
}

/** `/currency/<sub>`: a section's full list, with a way back to its place on the page. */
function CurrencySubPageView({
  section,
  page,
  range,
}: {
  section: CurrencySectionDef;
  page: CurrencySubPage;
  range: CurrencyRangeState;
}) {
  const { currency } = usePrefs();
  useShellStatus("closed", page.label);
  const back = `/currency?range=${range.range}#${section.id}`;
  return (
    <div className="currency-page currency-page--sub">
      <Link to={back} className="currency-page__back">
        <ChevronLeft aria-hidden size={16} />
        Currency · {section.label}
      </Link>
      <PageHeader
        title={page.label}
        titleOnPhone
        actions={
          page.ranged ? (
            <PageRangePicker range={range} />
          ) : undefined
        }
      />
      <page.Component currency={currency} range={range.range} />
    </div>
  );
}
