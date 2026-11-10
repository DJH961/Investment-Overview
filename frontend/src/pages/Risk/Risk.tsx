import { Inbox } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
import { Card } from "../../components/Card";
import { Chart, type ChartSeries } from "../../components/Chart";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { InfoTip } from "../../components/InfoTip";
import { ErrorState } from "../../components/ErrorState";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import { chartMoneyFormat, formatAxisDate, formatDate, formatNumber, formatPercent } from "../../lib/format";
import { relativeSeries, useHideAmounts } from "../../lib/hideAmounts";
import { glossaryText } from "../../lib/glossary";
import { usePrefs } from "../../lib/prefs";
import { useIsDesktop } from "../../lib/useMediaQuery";
import { usePersistentState } from "../../lib/usePersistentState";
import { type AnalyticsOut, toNum, useAnalytics } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
import { Maybe } from "../Periods/Maybe";
import "./Risk.scss";

const LOOKBACKS = [
  { value: "30", label: "1M" },
  { value: "90", label: "3M" },
  { value: "180", label: "6M" },
  { value: "365", label: "1Y" },
  { value: "1095", label: "3Y" },
  { value: "1825", label: "5Y" },
  // 0 = since the first transaction (the whole investment timeframe).
  { value: "0", label: "All" },
] as const;

type AttrRow = AnalyticsOut["attribution"][number];
type Kind = "pct" | "ratio";
type Tone = "none" | "sign";

interface Metric {
  key: keyof AnalyticsOut;
  label: string;
  kind: Kind;
  tone?: Tone;
}

/** Every metric, grouped, for the "All metrics" table (the headline four lead the page). */
const GROUPS: { id: string; title: string; metrics: Metric[] }[] = [
  {
    id: "returns",
    title: "Returns",
    metrics: [
      { key: "cagr", label: "CAGR", kind: "pct", tone: "sign" },
      { key: "twr", label: "TWR", kind: "pct", tone: "sign" },
      { key: "xirr", label: "XIRR", kind: "pct", tone: "sign" },
    ],
  },
  {
    id: "risk",
    title: "Risk and volatility",
    metrics: [
      { key: "volatility", label: "Volatility", kind: "pct" },
      { key: "sharpe", label: "Sharpe", kind: "ratio", tone: "sign" },
      { key: "sortino", label: "Sortino", kind: "ratio", tone: "sign" },
    ],
  },
  {
    id: "drawdown",
    title: "Drawdown and tail",
    metrics: [
      { key: "max_drawdown", label: "Max drawdown", kind: "pct", tone: "sign" },
      { key: "calmar", label: "Calmar", kind: "ratio" },
      { key: "ulcer", label: "Ulcer index", kind: "ratio" },
      { key: "var_95", label: "VaR (95%)", kind: "pct" },
      { key: "cvar_95", label: "CVaR (95%)", kind: "pct" },
      { key: "skew", label: "Skew", kind: "ratio" },
      { key: "kurtosis", label: "Excess kurtosis", kind: "ratio" },
    ],
  },
  {
    id: "market",
    title: "Benchmark and market",
    metrics: [
      { key: "beta", label: "Beta", kind: "ratio" },
      { key: "alpha", label: "Alpha", kind: "pct", tone: "sign" },
    ],
  },
];

/** One labelled row of the metrics table: name (with its explanation) left, figure right. */
function MetricRow({ label, tip, value, hint }: { label: string; tip?: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="risk-page__row">
      <dt className="risk-page__row-label">
        {label}
        {tip ? <InfoTip label={label} content={tip} /> : null}
      </dt>
      <dd className="risk-page__row-value">
        {value}
        {hint ? <span className="risk-page__row-hint">{hint}</span> : null}
      </dd>
    </div>
  );
}

const isLookback = (v: unknown): v is string => typeof v === "string" && LOOKBACKS.some((l) => l.value === v);

export function Risk() {
  const { currency } = usePrefs();
  const defaultLookback = String(useDisplayPrefs().riskLookback);
  const [lookback, setLookback] = usePersistentState(
    "risk.lookback",
    isLookback(defaultLookback) ? defaultLookback : "365",
    isLookback,
  );
  const q = useAnalytics(currency, Number(lookback));
  const { refetch: qRefetch } = q;
  const refetch = useCallback(() => void qRefetch(), [qRefetch]);
  useShellStatus(
    q.isError ? "stale" : q.isPending ? "loading" : "closed",
    q.data ? `As of ${formatDate(q.data.as_of)}` : "Loading",
    refetch,
    q.isFetching,
  );

  const d = q.data;
  // Desktop: the curve fills the height of the metrics table beside it.
  const desktop = useIsDesktop();
  const { hide } = useHideAmounts();
  const series = useMemo<ChartSeries[]>(() => {
    if (!d) return [];
    const all: ChartSeries[] = [
      { id: "portfolio", label: "Portfolio", tone: "primary", points: d.curve.map((p) => ({ t: p.date, v: toNum(p.portfolio_value) })) },
      {
        id: "benchmark",
        label: d.benchmark_is_funded ? `${d.benchmark_symbol} (funded)` : d.benchmark_symbol,
        tone: "benchmark",
        points: d.curve.map((p) => ({ t: p.date, v: toNum(p.benchmark_value) })),
      },
      { id: "contrib", label: "Net invested", tone: "muted", points: d.curve.map((p) => ({ t: p.date, v: toNum(p.cumulative_contributions) })) },
    ];
    // Hide numbers: plot as % of today's net invested (shapes kept, amounts not).
    return hide ? relativeSeries(all, "contrib", "last") : all;
  }, [d, hide]);

  const ccy = d?.ccy ?? currency;
  const money = (v: string | null | undefined, colored = false) => (
    <Money amount={toNum(v ?? null)} currency={ccy} colored={colored} />
  );

  const attrColumns: Column<AttrRow>[] = [
    { key: "symbol", header: "Holding", primary: true, cell: (r) => r.symbol },
    {
      key: "start",
      header: "Start",
      align: "right",
      phone: "hide",
      sortValue: (r) => toNum(r.start_value),
      cell: (r) => money(r.start_value),
    },
    {
      key: "end",
      header: "End",
      align: "right",
      phone: "hide",
      sortValue: (r) => toNum(r.end_value),
      cell: (r) => money(r.end_value),
    },
    {
      key: "net",
      header: "Net added",
      align: "right",
      phone: "hide",
      sortValue: (r) => toNum(r.net_contribution),
      cell: (r) => money(r.net_contribution),
    },
    {
      key: "pnl",
      header: "P&L",
      align: "right",
      phone: "headline",
      sortValue: (r) => toNum(r.absolute_pnl),
      cell: (r) => money(r.absolute_pnl, true),
    },
    {
      key: "pct",
      header: "% of return",
      align: "right",
      sortValue: (r) => toNum(r.pct_of_total_return),
      cell: (r) => <Percent ratio={toNum(r.pct_of_total_return)} />,
    },
  ];

  const metricValue = (m: Metric): ReactNode => {
    const n = toNum(d?.[m.key] as string | null);
    const body =
      m.kind === "pct" ? (
        <Percent ratio={n} colored={m.tone === "sign"} />
      ) : (
        <span className={m.tone === "sign" && n !== null && n !== 0 ? (n > 0 ? "risk-page__pos" : "risk-page__neg") : undefined}>
          {formatNumber(n)}
        </span>
      );
    return (
      <Maybe present={n !== null} ccy={currency}>
        {body}
      </Maybe>
    );
  };

  const diff = d ? toNum(d.benchmark_diff) : null;
  const diffPct = d ? toNum(d.benchmark_diff_pct) : null;
  const rf = d ? toNum(d.risk_free_rate) : null;
  const benchLabel = d ? `vs ${d.benchmark_symbol}${d.benchmark_is_funded ? " (funded)" : ""}` : "";

  return (
    <div className="risk-page">
      <PageHeader
        title="Risk"
        subtitle={d ? `${formatDate(d.start)} to ${formatDate(d.as_of)}` : "Risk, return and attribution."}
        actions={
          <SegmentedControl ariaLabel="Lookback" options={[...LOOKBACKS]} value={lookback} onChange={setLookback} />
        }
      />
      {q.isError && !q.data ? (
        <ErrorState title="Could not load analytics" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="18rem" />
      ) : !d || d.curve.length === 0 ? (
        <EmptyState icon={<Inbox aria-hidden />} title="No analytics yet" description="Import transactions to see risk metrics." />
      ) : (
        <div className="risk-page__stack">
          {/* Headline: the four figures that answer "how did it go, and at what risk?" */}
          <div className="risk-page__headline">
            <KpiTile
              label="CAGR"
              tooltip={glossaryText("cagr")}
              value={metricValue(GROUPS[0].metrics[0])}
              hint={
                <>
                  TWR <Percent ratio={toNum(d.twr)} signed /> · XIRR <Percent ratio={toNum(d.xirr)} signed />
                </>
              }
            />
            <KpiTile
              label="Volatility"
              tooltip={glossaryText("volatility")}
              value={metricValue(GROUPS[1].metrics[0])}
              hint={<>Sharpe {formatNumber(toNum(d.sharpe))} · Sortino {formatNumber(toNum(d.sortino))}</>}
            />
            <KpiTile
              label="Max drawdown"
              tooltip={glossaryText("max_drawdown")}
              value={metricValue(GROUPS[2].metrics[0])}
              hint={<>Calmar {formatNumber(toNum(d.calmar))} · VaR <Percent ratio={toNum(d.var_95)} /></>}
            />
            <KpiTile
              label={benchLabel}
              tooltip={glossaryText("benchmark")}
              value={
                <Maybe present={diff !== null} ccy={currency}>
                  {money(d.benchmark_diff, true)}
                </Maybe>
              }
              hint={
                diffPct !== null ? (
                  <>
                    <Percent ratio={diffPct} signed colored /> · beta {formatNumber(toNum(d.beta))}
                  </>
                ) : undefined
              }
            />
          </div>
          <div className="risk-page__main">
          <Card
            className="risk-page__metrics-card"
            title="All metrics"
            subtitle={lookback === "0" ? "Since the first transaction" : `${LOOKBACKS.find((l) => l.value === lookback)?.label ?? ""} lookback`}
            collapsibleId="risk.metrics"
          >
            <div className="risk-page__groups">
              {GROUPS.map((g) => (
                <section key={g.id} className="risk-page__group" aria-label={g.title}>
                  <h2 className="risk-page__group-title">{g.title}</h2>
                  <dl className="risk-page__rows">
                    {g.metrics.map((m) => (
                      <MetricRow key={m.key} label={m.label} tip={glossaryText(m.key)} value={metricValue(m)} />
                    ))}
                    {g.id === "risk" ? (
                      <MetricRow
                        label="Risk-free rate"
                        tip={glossaryText("risk_free")}
                        value={
                          <Maybe present={rf !== null} ccy={currency}>
                            <Percent ratio={rf} />
                          </Maybe>
                        }
                        hint={rf !== null ? d.risk_free_symbol : "no live rate"}
                      />
                    ) : null}
                    {g.id === "market" ? (
                      <MetricRow
                        label="Benchmark"
                        tip={glossaryText("benchmark")}
                        value={d.benchmark_symbol}
                        hint={d.benchmark_is_funded ? "funded" : "price only"}
                      />
                    ) : null}
                  </dl>
                </section>
              ))}
            </div>
          </Card>
          <Card
            className="risk-page__curve-card"
            title="Equity curve"
            subtitle={`Since ${formatDate(d.curve_start)}`}
            collapsibleId="risk.curve"
          >
            <Chart
              height={desktop ? 540 : 300}
              series={hide ? series : series.map((s) => ({ ...s, valueFormat: chartMoneyFormat(d.currency, "tooltip") }))}
              valueFormat={(v) => (hide ? formatPercent(v, { digits: 0 }) : chartMoneyFormat(d.currency, "axis")(v))}
              timeFormat={(t) => formatAxisDate(t, Infinity)}
              tooltipTimeFormat={(t) => formatDate(new Date(t))}
              ariaLabel={hide ? "Equity curve, as a share of net invested" : "Equity curve"}
            />
            {d.portfolio_last_value !== null ? (
              <p className="risk-page__note">
                Latest value {money(d.portfolio_last_value)} · net invested {money(d.net_invested_last)}
                {diff !== null ? (
                  <>
                    {" "}
                    · {diff >= 0 ? "ahead of" : "behind"} {d.benchmark_symbol} by {money(d.benchmark_diff)}
                  </>
                ) : null}
              </p>
            ) : null}
          </Card>
          </div>
          <Card title="Attribution" subtitle="What each holding added to the return" collapsibleId="risk.attribution">
            <DataTable
              className="risk-page__attribution"
              caption="Return attribution"
              columns={attrColumns}
              rows={d.attribution}
              rowKey={(r) => String(r.instrument_id)}
              defaultSort={{ key: "pnl", direction: "desc" }}
              emptyMessage="No attribution data."
            />
            {d.attribution.length > 0 ? (
              <dl className="risk-page__total" aria-label="Attribution total">
                <dt className="risk-page__total-label">Total</dt>
                <dd className="risk-page__total-values">
                  <span>Start {money(d.attribution_total.start_value)}</span>
                  <span>End {money(d.attribution_total.end_value)}</span>
                  <span>Net added {money(d.attribution_total.net_contribution)}</span>
                  <strong>P&amp;L {money(d.attribution_total.absolute_pnl, true)}</strong>
                </dd>
              </dl>
            ) : null}
            <p className="risk-page__note">{glossaryText("attribution")}</p>
          </Card>
        </div>
      )}
    </div>
  );
}
