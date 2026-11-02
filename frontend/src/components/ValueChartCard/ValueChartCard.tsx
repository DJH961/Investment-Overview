import clsx from "clsx";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Card } from "../Card";
import { Chart, type ChartSeries, type ChartXMode } from "../Chart";
import { ErrorState } from "../ErrorState";
import { IconButton } from "../IconButton";
import { Percent } from "../Percent";
import { useToast } from "../Toast";
import {
  chartMoneyFormat,
  formatDate,
  formatDayLabel,
  formatDayTime,
  formatPercent,
  formatShortDay,
  formatTime,
  todayIn,
} from "../../lib/format";
import { GRAPH_RANGES, rememberGraphRange, toNum, useGraph, type GraphRange } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useHideAmounts } from "../../lib/hideAmounts";
import { useTimeZone } from "../../lib/timezone";
import { usePersistentState } from "../../lib/usePersistentState";
import { useGraphReload } from "./useGraphReload";
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
const SECONDARY_KEY = "chart.overview.secondary";
const isRange = (v: unknown): v is GraphRange | null => v === null || GRAPH_RANGES.includes(v as GraphRange);

/**
 * The range to open with: the server's market-aware default while the market
 * is open (1D during the session), otherwise this device's last choice, then
 * the configured Overview default (Settings → Display), then the server default.
 */
export function initialRange(opts: {
  serverDefault?: GraphRange;
  marketOpen: boolean;
  remembered: GraphRange | null;
  configured?: GraphRange;
}): GraphRange {
  if (opts.marketOpen && opts.serverDefault) return opts.serverDefault;
  return opts.remembered ?? opts.configured ?? opts.serverDefault ?? "1m";
}

export interface ValueChartCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
  /** `GET /api/overview` `default_range` (undefined while loading). */
  defaultRange?: GraphRange;
  /** Settings → Display "Overview default range" (used when this device has no choice). */
  configuredRange?: GraphRange;
  marketOpen?: boolean;
  className?: string;
}

const pctFormat = (v: number) => formatPercent(v, { signed: true, digits: 1 });

/** Overview value chart: live 1D, range picker remembered per device, optional second-currency line. */
export function ValueChartCard({
  currency,
  defaultRange,
  configuredRange,
  marketOpen = false,
  className,
}: ValueChartCardProps) {
  const timeZone = useTimeZone();
  const [remembered, setRemembered] = usePersistentState<GraphRange | null>(RANGE_KEY, null, isRange);
  const [picked, setPicked] = useState<GraphRange | null>(null);
  const range = picked ?? initialRange({
    serverDefault: defaultRange,
    marketOpen,
    remembered,
    configured: configuredRange,
  });
  // Other-currency line: on by default, remembered per device.
  const [showSecondary, setShowSecondary] = usePersistentState<boolean>(SECONDARY_KEY, true);
  const graph = useGraph(range, currency);
  const { toast } = useToast();
  const { reload, busy: reloading } = useGraphReload(
    (r) => {
      const label = RANGE_LABELS[r.range as GraphRange] ?? r.range;
      if (!r.ok) toast({ title: `${label} graph reload failed`, tone: "error" });
      else
        toast({
          title: `${label} graph reloaded`,
          description: r.points === null ? undefined : `${r.points} point${r.points === 1 ? "" : "s"}`,
          tone: "success",
        });
    },
    (message) => toast({ title: "Graph reload failed", description: message, tone: "error" }),
  );
  const g = graph.data;
  // Format by the range actually drawn (a placeholder may still be the previous range).
  const shown: GraphRange = g?.range ?? range;

  const changeRange = (r: string) => {
    const next = r as GraphRange;
    setPicked(next);
    setRemembered(next);
    rememberGraphRange(next);
  };

  const { hide } = useHideAmounts();
  // Hide mode plots "% from range start" (the 1D previous close when known) on both lines.
  const base = (pts: { v?: string | null }[], ref: number | null): number | null => {
    const first = pts.map((p) => toNum(p.v)).find((v) => v !== null && v !== 0) ?? null;
    return ref !== null && ref !== 0 ? ref : first;
  };
  const series = useMemo<ChartSeries[]>(() => {
    if (!g) return [];
    if (hide) {
      const rel = (pts: typeof g.points, b: number | null) =>
        pts.map((p) => {
          const v = toNum(p.v);
          return { t: p.t, v: v === null || b === null ? null : v / b - 1 };
        });
      const ref = g.range === "1d" ? toNum(g.reference) : null;
      const out: ChartSeries[] = [{ id: "primary", label: g.ccy, points: rel(g.points, base(g.points, ref)) }];
      const sec = g.secondary;
      if (sec && sec.points.length) {
        out.push({
          id: "secondary",
          label: sec.ccy,
          points: rel(sec.points, base(sec.points, null)),
          axis: "right",
          valueFormat: pctFormat,
          hidden: !showSecondary,
        });
      }
      return out;
    }
    const out: ChartSeries[] = [
      { id: "primary", label: g.ccy, points: g.points.map((p) => ({ t: p.t, v: toNum(p.v) })) },
    ];
    const sec = g.secondary;
    const scale = toNum(sec?.scale);
    if (sec && scale !== null && scale > 0 && sec.points.length) {
      // Shared start point: the server's scale maps the other currency onto the
      // primary axis; the right axis and tooltip show its true values.
      out.push({
        id: "secondary",
        label: sec.ccy,
        points: sec.points.map((p) => ({ t: p.t, v: toNum(p.v) })),
        scale,
        axis: "right",
        valueFormat: chartMoneyFormat(sec.ccy, "tooltip"),
        hidden: !showSecondary,
      });
    }
    return out;
  }, [g, showSecondary, hide]);

  const intraday = shown === "1d" || shown === "1w";
  const sessions = shown === "1w" ? (g?.sessions ?? []) : [];
  const xMode: ChartXMode = shown === "1d" ? "time" : sessions.length ? "session" : "date";
  const axisFormat = hide ? pctFormat : chartMoneyFormat(currency, "axis");
  const tipFormat = hide ? pctFormat : chartMoneyFormat(currency, "tooltip");
  const timeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatShortDay(t, timeZone) : formatDate(new Date(t), "short");
  const tooltipTimeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatDayTime(t, timeZone) : formatDate(new Date(t), "medium");

  const prevCloseRaw = shown === "1d" ? toNum(g?.reference) : null;
  // Hide mode: the previous close is the 0% baseline.
  const prevClose = hide && prevCloseRaw !== null ? 0 : prevCloseRaw;
  const trend = shown === "1d" && g?.direction ? g.direction : undefined;
  let subtitle: string | undefined;
  if (shown === "1d" && g?.session_date) {
    subtitle = g.session_date === todayIn(timeZone) ? "Today" : formatDayLabel(g.session_date);
  }
  const growth = g?.growth ? toNum(g.growth.pct) : null;
  const coverage = intraday && g?.coverage && !g.coverage.complete ? g.coverage : null;
  const other = g?.secondary?.ccy ?? (currency === "EUR" ? "USD" : "EUR");

  return (
    <Card
      className={clsx("value-chart-card", className)}
      title="Value"
      collapsibleId="overview.chart"
      subtitle={subtitle}
      actions={
        <IconButton
          size="sm"
          label={`Reload ${RANGE_LABELS[range]} graph`}
          icon={<RefreshCw aria-hidden className={clsx(reloading === range && "value-chart-card__spin")} />}
          onClick={() => reload(range)}
          disabled={reloading !== null}
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
              prevClose !== null ? { value: prevClose, label: hide ? "Prev close" : `Prev close ${tipFormat(prevClose)}` } : undefined
            }
            trend={trend}
            rightAxisFormat={hide ? pctFormat : chartMoneyFormat(other, "axis")}
            onToggleSeries={(id) => {
              if (id === "secondary") setShowSecondary((v) => !v);
            }}
            xMode={xMode}
            sessions={sessions}
            valueFormat={axisFormat}
            timeFormat={timeFormat}
            tooltipTimeFormat={tooltipTimeFormat}
            busy={graph.isPlaceholderData || (graph.isFetching && !graph.isPending) || reloading === shown}
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
