import { Inbox } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { Chart, type ChartSeries } from "../../components/Chart";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { formatDate, formatMoney, formatNumber } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { type AnalyticsOut, toNum, useAnalytics } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
import { Maybe } from "../Periods/Maybe";
import "./Risk.scss";

const LOOKBACKS = [
  { value: "90", label: "3M" },
  { value: "180", label: "6M" },
  { value: "365", label: "1Y" },
  { value: "1095", label: "3Y" },
] as const;

type AttrRow = AnalyticsOut["attribution"][number];
type Kind = "pct" | "ratio";

const METRICS: { key: keyof AnalyticsOut; label: string; kind: Kind; tip: string }[] = [
  { key: "cagr", label: "CAGR", kind: "pct", tip: "Compound annual growth rate." },
  { key: "twr", label: "TWR", kind: "pct", tip: "Time-weighted return, ignoring the timing of cashflows." },
  { key: "xirr", label: "XIRR", kind: "pct", tip: "Money-weighted annualised return." },
  { key: "volatility", label: "Volatility", kind: "pct", tip: "Annualised standard deviation of daily returns." },
  { key: "sharpe", label: "Sharpe", kind: "ratio", tip: "Excess return per unit of volatility." },
  { key: "sortino", label: "Sortino", kind: "ratio", tip: "Excess return per unit of downside volatility." },
  { key: "max_drawdown", label: "Max drawdown", kind: "pct", tip: "Largest peak-to-trough fall." },
  { key: "calmar", label: "Calmar", kind: "ratio", tip: "Return divided by maximum drawdown." },
  { key: "ulcer", label: "Ulcer index", kind: "ratio", tip: "Depth and duration of drawdowns." },
  { key: "var_95", label: "VaR (95%)", kind: "pct", tip: "Daily loss exceeded on 5% of days." },
  { key: "cvar_95", label: "CVaR (95%)", kind: "pct", tip: "Average daily loss on the worst 5% of days." },
  { key: "beta", label: "Beta", kind: "ratio", tip: "Sensitivity to the benchmark." },
  { key: "alpha", label: "Alpha", kind: "pct", tip: "Return beyond what beta explains." },
  { key: "skew", label: "Skew", kind: "ratio", tip: "Asymmetry of returns." },
  { key: "kurtosis", label: "Excess kurtosis", kind: "ratio", tip: "Tail heaviness versus a normal distribution." },
];

export function Risk() {
  const { currency } = usePrefs();
  const [lookback, setLookback] = useState("365");
  const q = useAnalytics(currency, Number(lookback));
  const { refetch: qRefetch } = q;
  const refetch = useCallback(() => void qRefetch(), [qRefetch]);
  useShellStatus(
    q.isError ? "stale" : q.isPending ? "loading" : "closed",
    q.data ? `As of ${q.data.as_of}` : "Loading",
    refetch,
    q.isFetching,
  );

  const d = q.data;
  const series = useMemo<ChartSeries[]>(() => {
    if (!d) return [];
    return [
      { id: "portfolio", label: "Portfolio", tone: "primary", points: d.curve.map((p) => ({ t: p.date, v: toNum(p.portfolio_value) })) },
      {
        id: "benchmark",
        label: d.benchmark_is_funded ? `${d.benchmark_symbol} (funded)` : d.benchmark_symbol,
        tone: "benchmark",
        points: d.curve.map((p) => ({ t: p.date, v: toNum(p.benchmark_value) })),
      },
      { id: "contrib", label: "Net invested", tone: "muted", points: d.curve.map((p) => ({ t: p.date, v: toNum(p.cumulative_contributions) })) },
    ];
  }, [d]);

  const attrColumns: Column<AttrRow>[] = [
    { key: "symbol", header: "Symbol", primary: true, cell: (r) => r.symbol },
    {
      key: "pnl",
      header: "P&L",
      align: "right",
      sortValue: (r) => toNum(r.absolute_pnl),
      cell: (r) => <Money amount={toNum(r.absolute_pnl)} currency={d?.attribution_currency ?? currency} colored />,
    },
    {
      key: "pct",
      header: "% of return",
      align: "right",
      sortValue: (r) => toNum(r.pct_of_total_return),
      cell: (r) => <Percent ratio={toNum(r.pct_of_total_return)} />,
    },
  ];

  return (
    <div className="risk-page">
      <PageHeader
        title="Risk"
        subtitle="Risk, return and attribution."
        actions={
          <SegmentedControl ariaLabel="Lookback" options={[...LOOKBACKS]} value={lookback} onChange={setLookback} />
        }
      />
      {q.isError ? (
        <ErrorState title="Could not load analytics" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="18rem" />
      ) : !d || d.curve.length === 0 ? (
        <EmptyState icon={<Inbox aria-hidden />} title="No analytics yet" description="Import transactions to see risk metrics." />
      ) : (
        <div className="risk-page__stack">
          <div className="risk-page__metrics">
            {METRICS.map((m) => {
              const n = toNum(d[m.key] as string | null);
              return (
                <KpiTile
                  key={m.key}
                  label={m.label}
                  hint={m.tip}
                  value={
                    <Maybe present={n !== null} ccy={currency}>
                      {m.kind === "pct" ? <Percent ratio={n} /> : <span>{formatNumber(n)}</span>}
                    </Maybe>
                  }
                />
              );
            })}
          </div>
          <Card title="Equity curve" subtitle={`Since ${formatDate(d.curve_start)}`}>
            <Chart
              series={series}
              valueFormat={(v) => formatMoney(v, d.currency, { compact: true })}
              timeFormat={(t) => formatDate(new Date(t))}
              ariaLabel="Equity curve"
            />
          </Card>
          <Card title="Attribution">
            {d.attribution_currency === null ? (
              <p className="risk-page__note">
                Attribution is only available in EUR (it needs the EUR cashflow stream). Switch the reporting currency
                to EUR to see it.
              </p>
            ) : (
              <DataTable
                caption="Return attribution"
                columns={attrColumns}
                rows={d.attribution}
                rowKey={(r) => String(r.instrument_id)}
                defaultSort={{ key: "pnl", direction: "desc" }}
                emptyMessage="No attribution data."
              />
            )}
          </Card>
          <p className="risk-page__note">
            Risk-free rate: {d.risk_free_symbol}. Benchmark: {d.benchmark_symbol}.
          </p>
        </div>
      )}
    </div>
  );
}
