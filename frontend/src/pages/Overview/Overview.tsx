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
import { OverviewHero } from "../../components/OverviewHero";
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
import { useOverview } from "../../lib/queries/portfolio";
import { useShellStatus } from "../../lib/shell";
import { useIsDesktop } from "../../lib/useMediaQuery";
import "./Overview.scss";

/** Smallest plot height (the chart's default). */
const MIN_CHART = 280;

/**
 * Desktop: grow the value chart so its card ends level with the side column
 * (movers + holdings) instead of leaving empty page under one of them.
 */
function useMatchedChartHeight(active: boolean) {
  const desktop = useIsDesktop();
  const chartSlot = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    const slot = chartSlot.current;
    const col = side.current;
    if (!desktop || !active || !slot || !col || typeof ResizeObserver === "undefined") {
      setHeight(undefined);
      return;
    }
    const fit = () => {
      const plot = slot.querySelector<HTMLElement>(".chart__wrap");
      if (!plot) return;
      const chrome = slot.offsetHeight - plot.offsetHeight;
      const next = Math.max(MIN_CHART, Math.round(col.offsetHeight - chrome));
      setHeight((h) => (h === next ? h : next));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(slot);
    ro.observe(col);
    fit();
    return () => ro.disconnect();
  }, [desktop, active]);
  return { chartSlot, side, height };
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
  const fit = useMatchedChartHeight(Boolean(data));
  let chip: FreshnessView;
  if (overview.isError) chip = { status: "stale", label: "Offline" };
  else if (data?.freshness) chip = describeFreshness(data.freshness, { live, refresh, timeZone });
  else chip = { status: "loading", label: "Loading" };
  useShellStatus(chip.status, chip.label, () => void overview.refetch(), overview.isFetching, chip.short);

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

      {/* Desktop: the value chart beside movers + holdings (the chart grows to end
          level with them); lifetime FX sits under asset classes, next to the
          treemap. Narrower screens: one column in this order. */}
      <div className="overview-page__main">
        <div ref={fit.chartSlot} className="overview-page__chart">
          <ValueChartCard
            currency={currency}
            defaultRange={data?.default_range}
            configuredRange={overviewRange}
            marketOpen={data?.freshness?.market_state === "open"}
            chartHeight={fit.height}
          />
        </div>
        <div ref={fit.side} className="overview-page__side">
          <MoversCard movers={data?.movers} currency={currency} loading={loading} />
          <OverviewHoldings currency={currency} movers={data?.movers} />
        </div>
      </div>

      <div className="overview-page__row overview-page__row--alloc">
        <AllocationCard currency={currency} />
        <div className="overview-page__side">
          <AssetClassCard currency={currency} />
          {data && <CurrencyLifetime data={data} />}
        </div>
      </div>
    </div>
  );
}
