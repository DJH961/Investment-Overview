import clsx from "clsx";
import { useMemo, useState } from "react";
import { Card } from "../Card";
import { Chart } from "../Chart";
import { ErrorState } from "../ErrorState";
import { SegmentedControl } from "../SegmentedControl";
import { formatDate, formatMoney } from "../../lib/format";
import { GRAPH_RANGES, toNum, useGraph, type GraphRange } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./ValueChartCard.scss";

export interface ValueChartCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
  className?: string;
}

/** Overview value chart: range picker, optional second-currency line. */
export function ValueChartCard({ currency, className }: ValueChartCardProps) {
  const [range, setRange] = useState<GraphRange>("1m");
  const [compare, setCompare] = useState(false);
  const graph = useGraph(range, currency, compare);

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

  const fmtValue = (v: number) => formatMoney(v, currency, { digits: 0 });
  const prevClose = toNum(graph.data?.reference);
  const other = currency === "EUR" ? "USD" : "EUR";

  return (
    <Card
      className={clsx("value-chart-card", className)}
      title="Value"
      collapsibleId="overview.chart"
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
  );
}
