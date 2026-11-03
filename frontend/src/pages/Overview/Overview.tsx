import { Inbox } from "lucide-react";
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
import "./Overview.scss";

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

      {/* Desktop: chart and lifetime FX on the left, movers and holdings beside
          them. Narrower screens keep one column in the old order. */}
      <div className="overview-page__main">
        <div className="overview-page__col">
          <div className="overview-page__slot overview-page__slot--chart">
            <ValueChartCard
              currency={currency}
              defaultRange={data?.default_range}
              configuredRange={overviewRange}
              marketOpen={data?.freshness?.market_state === "open"}
            />
          </div>
          {data && (
            <div className="overview-page__slot overview-page__slot--lifetime">
              <CurrencyLifetime data={data} />
            </div>
          )}
          <div className="overview-page__slot overview-page__slot--alloc">
            <AllocationCard currency={currency} />
          </div>
        </div>
        <div className="overview-page__col">
          <div className="overview-page__slot overview-page__slot--movers">
            <MoversCard movers={data?.movers} currency={currency} loading={loading} />
          </div>
          <div className="overview-page__slot overview-page__slot--holdings">
            <OverviewHoldings currency={currency} movers={data?.movers} />
          </div>
          <div className="overview-page__slot overview-page__slot--classes">
            <AssetClassCard currency={currency} />
          </div>
        </div>
      </div>
    </div>
  );
}
