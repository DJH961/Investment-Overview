import { AlertTriangle, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { AllocationBar } from "../../components/AllocationBar";
import { Card } from "../../components/Card";
import { Chart } from "../../components/Chart";
import { DeltaBadge } from "../../components/DeltaBadge";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { Treemap } from "../../components/Treemap";
import { formatDate, formatMoney, formatNumber, formatPercent, formatTime } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import {
  GRAPH_RANGES,
  toNum,
  useAllocations,
  useGraph,
  useHoldings,
  useOverview,
  type GraphRange,
  type OverviewDto,
} from "../../lib/queries/portfolio";
import { useShellStatus } from "../../lib/shell";
import "./Overview.scss";

type Mover = OverviewDto["movers"]["winners"][number];

function MoverList({ title, movers, ccy }: { title: string; movers: Mover[]; ccy: string }) {
  return (
    <div className="overview-page__movers-col">
      <h3 className="overview-page__movers-title">{title}</h3>
      {movers.length === 0 ? (
        <p className="overview-page__muted">None</p>
      ) : (
        <ul className="overview-page__movers-list">
          {movers.map((m) => (
            <li key={m.symbol} className="overview-page__mover">
              <span className="overview-page__mover-symbol" title={m.name}>
                {m.symbol}
              </span>
              <Percent ratio={toNum(m.pct)} signed colored />
              <Money amount={toNum(m.move)} currency={ccy} signed colored compact />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Warnings({ warnings }: { warnings: OverviewDto["warnings"] }) {
  const items: string[] = [];
  if (warnings.zero_value.length) items.push(`No value for ${warnings.zero_value.join(", ")}`);
  if (warnings.bad_history.length) items.push(`Suspect price history for ${warnings.bad_history.join(", ")}`);
  if (warnings.missing_fx.length) items.push(`Missing FX rate for ${warnings.missing_fx.join(", ")}`);
  if (items.length === 0) return null;
  return (
    <div className="overview-page__warnings" role="alert">
      <AlertTriangle aria-hidden size={16} />
      <ul className="overview-page__warnings-list">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

export function Overview() {
  const { currency } = usePrefs();
  const [range, setRange] = useState<GraphRange>("1m");
  const [compare, setCompare] = useState(false);
  const overview = useOverview(currency);
  const holdings = useHoldings(currency);
  const allocations = useAllocations(currency);
  const graph = useGraph(range, currency, compare);

  const data = overview.data;
  const status = overview.isPending ? "loading" : overview.isError ? "stale" : data?.is_live ? "live" : "closed";
  const label = data
    ? `${data.is_live ? "Live" : "Closed"} · ${formatTime(data.generated_at)}`
    : overview.isPending
      ? "Loading"
      : "Offline";
  useShellStatus(status, label, () => void overview.refetch(), overview.isFetching);

  const series = useMemo(() => {
    const g = graph.data;
    if (!g) return [];
    const out = [
      {
        id: "primary",
        label: g.ccy,
        points: g.points.map((p) => ({ t: p.t, v: toNum(p.v) })),
      },
    ];
    if (compare && g.secondary) {
      out.push({
        id: "secondary",
        label: g.secondary.ccy,
        points: g.secondary.points.map((p) => ({ t: p.t, v: toNum(p.v) })),
      });
    }
    return out;
  }, [graph.data, compare]);

  const treemapItems = useMemo(
    () =>
      (holdings.data?.holdings ?? [])
        .map((h) => ({ h, value: toNum(h.value) ?? 0 }))
        .filter((x) => x.value > 0)
        .map(({ h, value }) => {
          const t = toNum(h.today_pct);
          return {
            id: h.symbol,
            label: h.symbol,
            value,
            tone: t === null || t === 0 ? ("neutral" as const) : t > 0 ? ("pos" as const) : ("neg" as const),
            detail: t === null ? undefined : formatPercent(t, { signed: true }),
          };
        }),
    [holdings.data],
  );

  const slices = useMemo(
    () =>
      (allocations.data?.current_by_asset_class ?? []).map((b) => ({
        id: b.label,
        label: b.label,
        actual: (toNum(b.pct) ?? 0) / 100,
      })),
    [allocations.data],
  );

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
  const k = data?.kpis;
  const split = data?.currency.return_split;
  const today = data?.currency.today;
  const fmtValue = (v: number) => formatMoney(v, currency, { digits: 0 });
  const prevClose = toNum(graph.data?.reference);
  const other = currency === "EUR" ? "USD" : "EUR";

  return (
    <div className="overview-page">
      <PageHeader
        title="Overview"
        subtitle={data ? `As of ${formatDate(data.as_of)} · ${data.position_count} positions` : undefined}
      />
      {data && <Warnings warnings={data.warnings} />}

      <div className="overview-page__kpis">
        <KpiTile
          label="Portfolio value"
          loading={loading}
          value={<Money amount={toNum(k?.total_value)} currency={currency} />}
        />
        <KpiTile
          label="Today"
          loading={loading}
          value={<Money amount={toNum(k?.daily_move)} currency={currency} signed colored />}
          delta={<DeltaBadge value={toNum(k?.daily_growth_pct)} />}
          hint={k?.daily_growth_as_of ? `as of ${formatDate(k.daily_growth_as_of)}` : undefined}
        />
        <KpiTile
          label="Total return"
          loading={loading}
          value={<Money amount={toNum(k?.capital_gain)} currency={currency} signed colored />}
          delta={<DeltaBadge value={toNum(k?.total_growth_compounded)} />}
          hint={k?.total_invested ? `of ${formatMoney(toNum(k.total_invested), currency, { compact: true })} invested` : undefined}
        />
        <KpiTile
          label="XIRR"
          loading={loading}
          value={<Percent ratio={toNum(k?.xirr)} signed colored />}
          hint={k?.ytd_xirr ? `YTD ${formatPercent(toNum(k.ytd_xirr), { signed: true })}` : undefined}
        />
        <KpiTile
          label="Currency effect"
          loading={loading}
          value={<Percent ratio={toNum(split?.currency_effect_pp)} signed colored />}
          hint={
            split?.investment_return == null
              ? undefined
              : `Investment ${formatPercent(toNum(split.investment_return), { signed: true })}`
          }
        />
      </div>

      {data && (
        <Card title="Return split" subtitle="Investment return versus currency effect">
          <dl className="overview-page__split">
            <div>
              <dt>Total return (EUR)</dt>
              <dd>
                <Percent ratio={toNum(split?.total_return_eur)} signed colored />
              </dd>
            </div>
            <div>
              <dt>Investment</dt>
              <dd>
                <Percent ratio={toNum(split?.investment_return)} signed colored />
              </dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>
                <Percent ratio={toNum(split?.currency_effect_pp)} signed colored />
              </dd>
            </div>
            <div>
              <dt>EUR/USD</dt>
              <dd>{formatNumber(toNum(data.fx_eur_usd), 4)}</dd>
            </div>
            <div>
              <dt>Rate move today</dt>
              <dd>
                <Percent ratio={toNum(today?.rate_move_pct)} signed colored />
              </dd>
            </div>
          </dl>
        </Card>
      )}

      <div className="overview-page__row">
        <Card
          className="overview-page__chart"
          title="Value"
          subtitle={range === "1d" && prevClose !== null ? `Previous close ${formatMoney(prevClose, currency)}` : undefined}
          actions={
            <SegmentedControl
              ariaLabel="Chart lines"
              size="sm"
              value={compare ? "both" : "one"}
              onChange={(v) => setCompare(v === "both")}
              options={[
                { value: "one", label: currency },
                { value: "both", label: `+ ${other}` },
              ]}
            />
          }
        >
          {graph.isError ? (
            <ErrorState message={graph.error.message} onRetry={() => void graph.refetch()} />
          ) : (
            <Chart
              series={series}
              range={range}
              ranges={GRAPH_RANGES}
              onRangeChange={(r) => setRange(r as GraphRange)}
              valueFormat={fmtValue}
              timeFormat={(t) => formatDate(new Date(t), "short")}
              loading={graph.isPending}
              emptyMessage="No history for this range yet."
              ariaLabel="Portfolio value over time"
            />
          )}
        </Card>

        <Card
          className="overview-page__movers"
          title="Top movers"
          subtitle={data?.movers.basis_date ? formatDate(data.movers.basis_date) : undefined}
        >
          {loading ? (
            <Skeleton height="6rem" />
          ) : (
            <div className="overview-page__movers-grid">
              <MoverList title="Winners" movers={data?.movers.winners ?? []} ccy={currency} />
              <MoverList title="Losers" movers={data?.movers.losers ?? []} ccy={currency} />
            </div>
          )}
        </Card>
      </div>

      <div className="overview-page__row overview-page__row--alloc">
        <Card title="Allocation">
          {holdings.isError ? (
            <ErrorState message={holdings.error.message} onRetry={() => void holdings.refetch()} />
          ) : holdings.isPending ? (
            <Skeleton height="12rem" />
          ) : (
            <Treemap items={treemapItems} ariaLabel="Holdings by value" />
          )}
        </Card>
        <Card title="Asset classes">
          {allocations.isError ? (
            <ErrorState message={allocations.error.message} onRetry={() => void allocations.refetch()} />
          ) : allocations.isPending ? (
            <Skeleton height="3rem" />
          ) : (
            <AllocationBar slices={slices} ariaLabel="Allocation by asset class" />
          )}
        </Card>
      </div>
    </div>
  );
}
