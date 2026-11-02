import clsx from "clsx";
import { useMemo, useState } from "react";
import { Card } from "../Card";
import { Chart, type ChartSeries, type ChartXMode } from "../Chart";
import { ErrorState } from "../ErrorState";
import { Percent } from "../Percent";
import { SegmentedControl } from "../SegmentedControl";
import {
  chartMoneyFormat,
  formatDate,
  formatDayLabel,
  formatDayTime,
  formatShortDay,
  formatTime,
  todayIn,
} from "../../lib/format";
import { GRAPH_RANGES, rememberGraphRange, toNum, useGraph, type GraphRange } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import { usePersistentState } from "../../lib/usePersistentState";
import "./ValueChartCard.scss";

export const RANGE_LABELS: Record<GraphRange, string> = {
  "1d": "1D",
  "1w": "1W",
  "1m": "1M",
  "3m": "3M",
  "6m": "6M",
  ytd: "YTD",
  "1y": "1Y",
  all: "ALL",
};

const RANGE_KEY = "chart.overview.range";
const isRange = (v: unknown): v is GraphRange | null => v === null || GRAPH_RANGES.includes(v as GraphRange);

/**
 * The range to open with: the server's market-aware default while the market
 * is open (1D during the session), otherwise this device's last choice, then
 * the server default.
 */
export function initialRange(opts: {
  serverDefault?: GraphRange;
  marketOpen: boolean;
  remembered: GraphRange | null;
}): GraphRange {
  if (opts.marketOpen && opts.serverDefault) return opts.serverDefault;
  return opts.remembered ?? opts.serverDefault ?? "1m";
}

export interface ValueChartCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
  /** `GET /api/overview` `default_range` (undefined while loading). */
  defaultRange?: GraphRange;
  marketOpen?: boolean;
  className?: string;
}

/** Overview value chart: live 1D, range picker remembered per device, optional second-currency line. */
export function ValueChartCard({ currency, defaultRange, marketOpen = false, className }: ValueChartCardProps) {
  const timeZone = useTimeZone();
  const [remembered, setRemembered] = usePersistentState<GraphRange | null>(RANGE_KEY, null, isRange);
  const [picked, setPicked] = useState<GraphRange | null>(null);
  const range = picked ?? initialRange({ serverDefault: defaultRange, marketOpen, remembered });
  const [compare, setCompare] = useState(false);
  const graph = useGraph(range, currency);
  const g = graph.data;
  // Format by the range actually drawn (a placeholder may still be the previous range).
  const shown: GraphRange = g?.range ?? range;

  const changeRange = (r: string) => {
    const next = r as GraphRange;
    setPicked(next);
    setRemembered(next);
    rememberGraphRange(next);
  };

  const series = useMemo<ChartSeries[]>(() => {
    if (!g) return [];
    const out: ChartSeries[] = [
      { id: "primary", label: g.ccy, points: g.points.map((p) => ({ t: p.t, v: toNum(p.v) })) },
    ];
    if (compare && g.secondary) {
      out.push({
        id: "secondary",
        label: g.secondary.ccy,
        points: g.secondary.points.map((p) => ({ t: p.t, v: toNum(p.v) })),
      });
    }
    return out;
  }, [g, compare]);

  const intraday = shown === "1d" || shown === "1w";
  const xMode: ChartXMode = shown === "1d" ? "time" : "date";
  const axisFormat = chartMoneyFormat(currency, "axis");
  const tipFormat = chartMoneyFormat(currency, "tooltip");
  const timeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatShortDay(t, timeZone) : formatDate(new Date(t), "short");
  const tooltipTimeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatDayTime(t, timeZone) : formatDate(new Date(t), "medium");

  const prevClose = shown === "1d" ? toNum(g?.reference) : null;
  const trend = shown === "1d" && g?.direction ? g.direction : undefined;
  let subtitle: string | undefined;
  if (shown === "1d" && g?.session_date) {
    subtitle = g.session_date === todayIn(timeZone) ? "Today" : formatDayLabel(g.session_date);
  }
  const growth = g?.growth ? toNum(g.growth.pct) : null;
  const coverage = intraday && g?.coverage && !g.coverage.complete ? g.coverage : null;
  const other = currency === "EUR" ? "USD" : "EUR";

  return (
    <Card
      className={clsx("value-chart-card", className)}
      title="Value"
      collapsibleId="overview.chart"
      subtitle={subtitle}
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
      {graph.isError && !g ? (
        <ErrorState message={graph.error.message} onRetry={() => void graph.refetch()} />
      ) : (
        <>
          <Chart
            series={series}
            range={range}
            ranges={GRAPH_RANGES}
            rangeLabel={(r) => RANGE_LABELS[r as GraphRange] ?? r}
            onRangeChange={changeRange}
            headerExtra={
              growth !== null ? (
                <span className="value-chart-card__growth" data-testid="range-growth">
                  <Percent ratio={growth} signed colored />
                  <span className="value-chart-card__growth-label">{RANGE_LABELS[shown]}</span>
                </span>
              ) : undefined
            }
            referenceLine={
              prevClose !== null ? { value: prevClose, label: `Prev close ${tipFormat(prevClose)}` } : undefined
            }
            trend={trend}
            xMode={xMode}
            valueFormat={axisFormat}
            timeFormat={timeFormat}
            tooltipTimeFormat={tooltipTimeFormat}
            busy={graph.isPlaceholderData || (graph.isFetching && !graph.isPending)}
            loading={graph.isPending}
            emptyMessage="No history for this range yet."
            ariaLabel="Portfolio value over time"
          />
          {coverage && (
            <p className="value-chart-card__note">
              Intraday shape complete for {coverage.covered} of {coverage.total} sessions.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
