import clsx from "clsx";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Card } from "../Card";
import { Chart, type ChartSeries, type ChartXMode } from "../Chart";
import { ErrorState } from "../ErrorState";
import { formatStamp } from "../Freshness";
import { IconButton } from "../IconButton";
import { InfoTip } from "../InfoTip";
import { Percent } from "../Percent";
import { useToast } from "../Toast";
import {
  chartMoneyFormat,
  formatAxisDate,
  formatDate,
  formatDayLabel,
  formatDayTime,
  formatShortDay,
  formatTime,
  todayIn,
} from "../../lib/format";
import { useInstruments } from "../../lib/queries/instruments";
import { GRAPH_RANGES, rememberGraphRange, toNum, useGraph, type GraphRange } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { useHideAmounts } from "../../lib/hideAmounts";
import { useTimeZone } from "../../lib/timezone";
import { usePersistentState } from "../../lib/usePersistentState";
import { buildValueSeries } from "./valueSeries";
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

/**
 * "NAVs estimated from ETF twins": one short line however many funds are
 * estimated; the fund -> twin mapping is in the (i) tooltip. Mounted only while
 * an estimate is on screen, so the instruments list is fetched only then.
 */
export function EstimatedNote({ funds, week }: { funds: string[]; week: boolean }) {
  const twins = useInstruments().data;
  const twinOf = (symbol: string) => twins?.find((i) => i.symbol === symbol)?.intraday_twin ?? null;
  return (
    <p className="value-chart-card__note" data-testid="funds-estimated-note">
      <span>NAVs estimated from ETF twins</span>
      <InfoTip
        label="estimated NAVs"
        content={
          <div className="value-chart-card__twins">
            <p className="value-chart-card__twins-text">
              Until a fund's official NAV posts, its line follows its ETF twin{week ? " (latest session only)" : ""}.
            </p>
            <ul className="value-chart-card__twins-list">
              {funds.map((f) => (
                <li key={f} className="value-chart-card__twins-item">
                  {f} → {twinOf(f) ?? "…"}
                </li>
              ))}
            </ul>
          </div>
        }
      />
    </p>
  );
}

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
  // Same points, scale and baseline in both modes; hide mode only masks labels.
  const built = useMemo(() => (g ? buildValueSeries(g, { hide, showSecondary }) : null), [g, showSecondary, hide]);
  const series = useMemo<ChartSeries[]>(() => built?.series ?? [], [built]);

  const intraday = shown === "1d" || shown === "1w";
  const sessions = shown === "1w" ? (g?.sessions ?? []) : [];
  const xMode: ChartXMode = shown === "1d" ? "time" : sessions.length ? "session" : "date";
  const axisFormat = hide && built ? built.formats.primary : chartMoneyFormat(currency, "axis");
  const tipFormat = chartMoneyFormat(currency, "tooltip");
  const timeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w"
        ? formatShortDay(t, timeZone)
        : formatAxisDate(t, shown === "1y" || shown === "all" ? Infinity : 0);
  const tooltipTimeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatDayTime(t, timeZone) : formatDate(new Date(t), "medium");

  const prevCloseRaw = shown === "1d" ? toNum(g?.reference) : null;
  const prevClose = prevCloseRaw;
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
      title="Graph"
      collapsibleId="overview.chart"
      // The range's growth sits beside the title rather than over the plot: it is
      // the one number this card exists to report. `actions` hides it when the card
      // is folded, which is right — it describes a chart that is no longer on screen.
      actions={
        <>
          <span className="value-chart-card__growth" data-testid="range-growth">
            {growth !== null && <Percent ratio={growth} signed colored />}
            <span className="value-chart-card__growth-label">
              {subtitle ? `${RANGE_LABELS[shown]} · ${subtitle}` : RANGE_LABELS[shown]}
            </span>
          </span>
          <IconButton
            size="sm"
            label={`Reload ${RANGE_LABELS[range]} graph`}
            icon={<RefreshCw aria-hidden className={clsx(reloading === range && "value-chart-card__spin")} />}
            onClick={() => reload(range)}
            disabled={reloading !== null}
          />
        </>
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
            // One line for every range (the 1D day label sits here too), so
            // switching ranges never moves the chart up or down.
            referenceLine={
              prevClose !== null ? { value: prevClose, label: hide ? "Prev close" : `Prev close ${tipFormat(prevClose)}` } : undefined
            }
            trend={trend}
            rightAxisFormat={hide && built ? built.formats.secondary : chartMoneyFormat(other, "axis")}
            onToggleSeries={(id) => {
              if (id === "secondary") setShowSecondary((v) => !v);
            }}
            xMode={xMode}
            sessions={sessions}
            valueFormat={axisFormat}
            timeFormat={timeFormat}
            tooltipTimeFormat={tooltipTimeFormat}
            // Dim only while the curve on screen is another range's (or a manual
            // reload runs); a background refresh of the same range stays crisp.
            busy={graph.isPlaceholderData || reloading === shown}
            loading={graph.isPending}
            emptyMessage="No history for this range yet."
            ariaLabel="Portfolio value over time"
          />
          {(shown === "1d" || shown === "1w") && g?.funds_estimated && (
            <EstimatedNote funds={g.estimated_funds} week={shown === "1w"} />
          )}
          {(shown === "1d" || shown === "1w") && (g?.data_gaps?.length ?? 0) > 0 && (
            <p className="value-chart-card__note" data-testid="data-gaps-note">
              No market data from the price provider{" "}
              {(g?.data_gaps ?? [])
                .map((gap) => `${formatStamp(gap.start, { timeZone })}–${formatStamp(gap.end, { timeZone })}`)
                .join(", ")}
              ; the line is drawn straight across.
            </p>
          )}
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
