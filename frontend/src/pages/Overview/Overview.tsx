import { Inbox } from "lucide-react";
import { AllocationCard } from "../../components/AllocationCard";
import { AssetClassCard } from "../../components/AssetClassCard";
import { CurrencyBox } from "../../components/CurrencyBox";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { KpiGrid } from "../../components/KpiGrid";
import { MoversCard } from "../../components/MoversCard";
import { OverviewWarnings } from "../../components/OverviewWarnings";
import { PageHeader } from "../../components/PageHeader";
import { ValueChartCard } from "../../components/ValueChartCard";
import { formatDate, formatTime } from "../../lib/format";
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

  const data = overview.data;
  const status = overview.isPending ? "loading" : overview.isError ? "stale" : data?.is_live ? "live" : "closed";
  const label = data
    ? `${data.is_live ? "Live" : "Closed"} · ${formatTime(data.generated_at)}`
    : overview.isPending
      ? "Loading"
      : "Offline";
  useShellStatus(status, label, () => void overview.refetch(), overview.isFetching);

  if (overview.isError) {
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

      <KpiGrid data={data} currency={currency} loading={loading} />

      {data && <CurrencyBox data={data} />}

      <div className="overview-page__row">
        <ValueChartCard currency={currency} />
        <MoversCard movers={data?.movers} currency={currency} loading={loading} />
      </div>

      <div className="overview-page__row overview-page__row--alloc">
        <AllocationCard currency={currency} />
        <AssetClassCard currency={currency} />
      </div>
    </div>
  );
}
