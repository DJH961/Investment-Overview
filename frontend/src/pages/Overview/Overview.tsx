import { Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AllocationCard } from "../../components/AllocationCard";
import { AssetClassCard } from "../../components/AssetClassCard";
import { CurrencyBox } from "../../components/CurrencyBox";
import { CurrencyLifetime } from "../../components/CurrencyLifetime";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { KpiGrid } from "../../components/KpiGrid";
import { MoversCard } from "../../components/MoversCard";
import { dayMoveLabel, OverviewHero } from "../../components/OverviewHero";
import { OverviewHoldings } from "../../components/OverviewHoldings";
import { OverviewWarnings } from "../../components/OverviewWarnings";
import { PageHeader } from "../../components/PageHeader";
import { ValueChartCard } from "../../components/ValueChartCard";
import { describeFreshness, type FreshnessView } from "../../components/Freshness";
import { formatDate } from "../../lib/format";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import { useLiveStatus } from "../../lib/live";
import { useRefreshState } from "../../lib/refresh";
import { useTimeZone } from "../../lib/timezone";
import { usePrefs } from "../../lib/prefs";
import { toNum, useOverview } from "../../lib/queries/portfolio";
import { useShellStatus, useShellSummary } from "../../lib/shell";
import { useIsDesktop } from "../../lib/useMediaQuery";
import "./Overview.scss";

/** The treemap's own default height. */
const MIN_TREEMAP = 280;

/**
 * Desktop: size the treemap so its card ends level with the stack beside it
 * (asset classes + lifetime FX). Phones and tablets keep the default height.
 */
function useTreemapHeight(active: boolean) {
  const desktop = useIsDesktop();
  const slot = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    const own = slot.current;
    const col = side.current;
    if (!desktop || !active || !own || !col || typeof ResizeObserver === "undefined") {
      setHeight(undefined);
      return;
    }
    const fit = () => {
      const map = own.querySelector<HTMLElement>(".treemap");
      if (!map) return;
      const chrome = own.offsetHeight - map.offsetHeight;
      const next = Math.max(MIN_TREEMAP, Math.round(col.offsetHeight - chrome));
      setHeight((h) => (h === next ? h : next));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(own);
    ro.observe(col);
    fit();
    return () => ro.disconnect();
  }, [desktop, active]);
  return { slot, side, height };
}

/**
 * Overview page: composes one component per section so each later package
 * (live chip, currency box, KPI grid, movers, holdings list, chart) owns a file.
 * Every section card is collapsible and remembers its fold state (`iv.fold.overview.*`).
 */
export function Overview() {
  const { currency } = usePrefs();
  const overview = useOverview(currency);
  const { overviewRange } = useDisplayPrefs();

  const live = useLiveStatus();
  const refresh = useRefreshState();
  const timeZone = useTimeZone();

  const data = overview.data;
  const { slot: treemapSlot, side: treemapSide, height: treemapHeight } = useTreemapHeight(Boolean(data));
  let chip: FreshnessView;
  if (overview.isError) chip = { status: "stale", label: "Offline" };
  else if (data?.freshness) chip = describeFreshness(data.freshness, { live, refresh, timeZone, sessionDate: data.kpis?.daily_growth_as_of });
  else chip = { status: "loading", label: "Loading" };
  useShellStatus(chip.status, chip.label, () => void overview.refetch(), overview.isFetching, chip.short, chip.updated);
  useShellSummary(
    data?.kpis
      ? {
          value: toNum(data.kpis.total_value),
          currency,
          pct: toNum(data.kpis.daily_growth_pct),
          move: toNum(data.kpis.daily_move),
          dayLabel: dayMoveLabel(data.kpis.daily_growth_as_of, { timeZone }).replace("Today", "today"),
        }
      : undefined,
  );

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
        <EmptyState
          icon={<Inbox aria-hidden />}
          title="No positions yet"
          description="Import a broker file from Transactions to see your portfolio here."
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
      {data && <OverviewWarnings warnings={data.warnings} />}

      <OverviewHero data={data} currency={currency} loading={loading} />

      <KpiGrid data={data} currency={currency} loading={loading} />

      {data && <CurrencyBox data={data} />}

      {/* Full width, top to bottom: chart, movers, holdings. */}
      <ValueChartCard
        currency={currency}
        defaultRange={data?.default_range}
        configuredRange={overviewRange}
        marketOpen={data?.freshness?.market_state === "open"}
      />
      <MoversCard movers={data?.movers} currency={currency} loading={loading} />

      <OverviewHoldings currency={currency} movers={data?.movers} />

      {/* The secondary lifetime FX card sits under asset classes, beside the treemap. */}
      <div className="overview-page__row overview-page__row--alloc">
        <div ref={treemapSlot} className="overview-page__cell">
          <AllocationCard currency={currency} height={treemapHeight} />
        </div>
        <div ref={treemapSide} className="overview-page__side">
          <AssetClassCard currency={currency} />
          {data && <CurrencyLifetime data={data} />}
        </div>
      </div>
    </div>
  );
}
