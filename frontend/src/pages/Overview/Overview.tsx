import { Inbox } from "lucide-react";
import { SHOW_CURRENCY_PAGE } from "../../lib/features";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { useCallback, useEffect, useRef, useState } from "react";
import { AllocationCard } from "../../components/AllocationCard";
import { AssetClassCard } from "../../components/AssetClassCard";
import { CurrencyBox } from "../../components/CurrencyBox";
import { CurrencyLifetime } from "../../components/CurrencyLifetime";
import { DailyBrief } from "../../components/DailyBrief";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { HeroIntraday } from "../../components/HeroIntraday";
import { KpiGrid } from "../../components/KpiGrid";
import { MoversCard } from "../../components/MoversCard";
import { OverviewHero } from "../../components/OverviewHero";
import { OverviewHoldings } from "../../components/OverviewHoldings";
import { OverviewWarnings } from "../../components/OverviewWarnings";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { ValueChartCard } from "../../components/ValueChartCard";
import { useMarketPhase } from "../../lib/marketPhase";
import { describeFreshness, useLiveGrace, type FreshnessView } from "../../components/Freshness";
import { formatDate } from "../../lib/format";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import { useLiveStatus } from "../../lib/live";
import { useRefreshState } from "../../lib/refresh";
import { useTimeZone } from "../../lib/timezone";
import { usePrefs } from "../../lib/prefs";
import { useOverview } from "../../lib/queries/portfolio";
import { useShellStatus } from "../../lib/shell";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { TrendChip } from "../../components/TrendChip";
import { OnboardingCard } from "./OnboardingCard";
import { useRateLine } from "./useRateLine";
import "./Overview.scss";

function EmptyActions() {
  const navigate = useNavigate();
  return (
    <>
      <Button variant="primary" onClick={() => navigate("/import")}>
        Import a broker file
      </Button>{" "}
      <Button variant="secondary" onClick={() => navigate("/transactions")}>
        Add a transaction
      </Button>
    </>
  );
}

const WIDE_QUERY = "(min-width: 1280px)";

/** The treemap never gets smaller than this (14rem) or taller than MAX_TREEMAP on wide screens. */
const MIN_TREEMAP = 224;
const MAX_TREEMAP = 520;

/**
 * Wide screens: the details row's main column (Allocation, then asset classes) and
 * the side column (lifetime currency) end level. The treemap takes what is left,
 * within a sensible range. Narrower screens keep the treemap's own default height.
 */
function useTreemapHeight(active: boolean) {
  const wide = useMediaQuery(WIDE_QUERY);
  const main = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    const colMain = main.current;
    const colSide = side.current;
    if (!wide || !active || !colMain || !colSide || typeof ResizeObserver === "undefined") {
      setHeight(undefined);
      return;
    }
    const fit = () => {
      const map = colMain.querySelector<HTMLElement>(".treemap");
      const alloc = colMain.querySelector<HTMLElement>(".allocation-card");
      if (!map || !alloc) return;
      const kids = Array.from(colMain.children) as HTMLElement[];
      const chrome = alloc.offsetHeight - map.offsetHeight;
      const gap = Number.parseFloat(getComputedStyle(colMain).rowGap) || 0;
      const others = kids.filter((k) => k !== alloc).reduce((a, k) => a + k.offsetHeight, 0);
      const room = colSide.offsetHeight - others - gap * (kids.length - 1) - chrome;
      const next = Math.min(MAX_TREEMAP, Math.max(MIN_TREEMAP, Math.round(room)));
      setHeight((h) => (h === next ? h : next));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(colMain);
    ro.observe(colSide);
    for (const el of Array.from(colMain.children)) ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [wide, active]);
  return { main, side, height };
}

/**
 * Overview page: composes one component per section so each later package
 * (live chip, currency box, KPI grid, movers, holdings list, chart) owns a file.
 * Every section card is collapsible and remembers its fold state (`iv.fold.overview.*`).
 */
export function Overview() {
  const { currency } = usePrefs();
  const overview = useOverview(currency);
  const rateLine = useRateLine();
  const { overviewRange } = useDisplayPrefs();

  const live = useLiveGrace(useLiveStatus());
  const refresh = useRefreshState();
  const timeZone = useTimeZone();

  const data = overview.data;
  const { phase } = useMarketPhase(data?.freshness, Boolean(data?.daily_caption?.live));
  const qc = useQueryClient();
  // The clock reached an open or close: the server's next instants, and maybe a Brief.
  const onClockBoundary = useCallback(() => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "overview" || q.queryKey[0] === "brief" });
  }, [qc]);
  const { main: mainCol, side: sideCol, height: treemapHeight } = useTreemapHeight(Boolean(data));
  let chip: FreshnessView;
  if (overview.isError) chip = { status: "stale", label: "Offline" };
  else if (data?.freshness) chip = describeFreshness(data.freshness, { live, refresh, timeZone, sessionDate: data.kpis?.daily_growth_as_of, phase });
  else chip = { status: "loading", label: "Loading" };
  useShellStatus(chip.status, chip.label, () => void overview.refetch(), overview.isFetching, chip.short, chip.updated);

  if (overview.isError && !data) {
    return (
      <div className="overview-page">
        <PageHeader title="Overview" />
        <ErrorState message={overview.error.message} onRetry={() => void overview.refetch()} />
      </div>
    );
  }
  if (data && data.position_count === 0) {
    return (
      <div className="overview-page">
        <PageHeader title="Overview" />
        <OnboardingCard />
        <EmptyState
          icon={<Inbox aria-hidden />}
          title="No positions yet"
          description="Import a broker file to see your portfolio here, or add a transaction by hand."
          action={<EmptyActions />}
        />
      </div>
    );
  }

  const loading = overview.isPending;

  return (
    <div className="overview-page">
      <PageHeader
        title="Overview"
        subtitle={data ? `As of ${formatDate(data.as_of)} · ${data.position_count} positions` : undefined}
      />
      <OnboardingCard />
      {data && <OverviewWarnings warnings={data.warnings} />}

      {/* v7: the Daily Brief, directly above the stage, only when the server says one is due. */}
      <DailyBrief currency={currency} />
      {/*
        The stage: the portfolio value, today's move and the chart as one composed
        statement on one lit surface, the centre of the app.
      */}
      <section className="overview-page__stage" aria-label="Portfolio value and chart">
        <OverviewHero
          data={data}
          currency={currency}
          loading={loading}
          aside={(clock) => <HeroIntraday currency={currency} clock={clock} />}
          onClockBoundary={onClockBoundary}
          embedded
        />
        <ValueChartCard
          embedded
          className="overview-page__stage-chart"
          currency={currency}
          defaultRange={data?.default_range}
          configuredRange={overviewRange}
          marketOpen={data?.freshness?.market_state === "open"}
          lastSession={data?.last_session}
        />
      </section>

      <KpiGrid data={data} currency={currency} loading={loading} />

      {/*
        Today first, details lower (owner, 7.0.1). Today: currency effect and top
        movers, side by side from tablet up (movers left); on a phone currency
        comes first, as in v6. Then Holdings at full width, then the details row.
      */}
      <section className="overview-page__today" aria-label="Today">
        <div className="overview-page__today-currency">
          {data ? (
            <CurrencyBox
              data={data}
              trend={rateLine.trend ? <TrendChip trend={rateLine.trend} /> : undefined}
              footer={
                SHOW_CURRENCY_PAGE ? (
                  <Link to="/currency" className="currency-box__link">
                    Currency page →
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <Skeleton height="12rem" />
          )}
        </div>
        <div className="overview-page__today-movers">
          <MoversCard movers={data?.movers} currency={currency} loading={loading} lastSession={data?.last_session} />
        </div>
      </section>

      <OverviewHoldings currency={currency} movers={data?.movers} />

      {/*
        Details: Allocation (treemap, asset classes under it) beside the lifetime
        currency card on wide screens; the treemap closes the height difference.
      */}
      <div className="overview-page__details">
        <div ref={mainCol} className="overview-page__main">
          <AllocationCard currency={currency} height={treemapHeight} />
          <AssetClassCard currency={currency} />
        </div>
        <div ref={sideCol} className="overview-page__side">
          {data ? <CurrencyLifetime data={data} rateLine={rateLine.line} /> : <Skeleton height="9rem" />}
        </div>
      </div>
    </div>
  );
}
