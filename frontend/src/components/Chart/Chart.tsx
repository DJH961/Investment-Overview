/* The plot is a custom scrubbable graphic: an svg that takes focus, arrow keys and pointer input. */
/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role */
import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { EmptyState } from "../EmptyState";
import { SegmentedControl } from "../SegmentedControl";
import { Skeleton } from "../Skeleton";
import "./Chart.scss";

export type ChartTone = "primary" | "benchmark" | "muted";

/**
 * x axis layout: evenly spaced dates (default), clock-aligned intraday ticks, or
 * `session`: each exchange session an equal band (nights/weekends squeezed out).
 */
export type ChartXMode = "date" | "time" | "session";

/** One exchange session (UTC instants) for `xMode="session"`. */
export interface ChartSession {
  date: string;
  open: string | number;
  close: string | number;
}

export interface SessionBand {
  date: string;
  open: number;
  close: number;
  x0: number;
  x1: number;
}

export interface SessionLayout {
  bands: SessionBand[];
  /** Index of the session a time belongs to (before the first: 0; between two: the earlier). */
  index: (t: number) => number;
  x: (t: number) => number;
}

/**
 * Lays sessions side by side as equal bands across `[left, left + width]`. A
 * time maps to its fraction of its session's open→close (clamped), so the live
 * session keeps a full band and its tip sits at its true time of day.
 */
export function sessionLayout(sessions: ChartSession[], left: number, width: number): SessionLayout {
  const sorted = sessions
    .map((s) => ({ date: s.date, open: toTime(s.open), close: toTime(s.close) }))
    .filter((s) => Number.isFinite(s.open) && Number.isFinite(s.close) && s.close > s.open)
    .sort((a, b) => a.open - b.open);
  const bandW = sorted.length ? width / sorted.length : width;
  const bands = sorted.map((s, i) => ({ ...s, x0: left + i * bandW, x1: left + (i + 1) * bandW }));
  const index = (t: number) => {
    let i = 0;
    for (let k = 0; k < bands.length; k++) if (bands[k].open <= t) i = k;
    return i;
  };
  const x = (t: number) => {
    if (!bands.length) return left;
    const b = bands[index(t)];
    const f = Math.min(1, Math.max(0, (t - b.open) / (b.close - b.open)));
    return b.x0 + f * (b.x1 - b.x0);
  };
  return { bands, index, x };
}

/** Direction of the primary line versus its reference (colours line, area and end marker). */
export type ChartTrend = "up" | "down" | "flat";

export interface ChartPoint {
  t: string | number;
  /** null leaves a gap in the line. */
  v: number | null;
}

export interface ChartSeries {
  id: string;
  label: string;
  points: ChartPoint[];
  tone?: ChartTone;
  /**
   * Plot at `v / scale` so this line starts at the same pixel as the primary
   * (server `secondary.scale`). Pure display mapping; the tooltip shows `v`.
   */
  scale?: number;
  /** "right": label the right axis as left ticks × `scale` (needs `rightAxisFormat`). */
  axis?: "left" | "right";
  /** Tooltip formatter for this series' true values (default: chart `valueFormat`). */
  valueFormat?: (v: number) => string;
  /** Not drawn; the legend still lists it so it can be switched back on. */
  hidden?: boolean;
}

/** A horizontal guide at a fixed value (e.g. cost basis). It is part of the y range. */
export interface ChartReferenceLine {
  value: number;
  label?: string;
}

export interface ChartProps {
  series: ChartSeries[];
  referenceLine?: ChartReferenceLine;
  range?: string;
  onRangeChange?: (range: string) => void;
  ranges?: string[];
  valueFormat: (v: number) => string;
  /** Axis tick labels. */
  timeFormat: (t: number) => string;
  /** Tooltip time label (default: `timeFormat`). */
  tooltipTimeFormat?: (t: number) => string;
  /** Range button labels (default: the range id). */
  rangeLabel?: (range: string) => string;
  /** Extra content in the header row, left of the range control (growth, reload). */
  headerExtra?: ReactNode;
  xMode?: ChartXMode;
  /** Colours the primary series green/red and draws a ▲/▼ end marker. */
  trend?: ChartTrend;
  /** Keep the drawn curve but dim it while new data loads. */
  busy?: boolean;
  /** Right-axis tick labels for a scaled `axis: "right"` series (true values in its currency). */
  rightAxisFormat?: (v: number) => string;
  /** Makes legend entries toggle buttons. */
  onToggleSeries?: (id: string) => void;
  /** Exchange sessions for `xMode="session"` (falls back to `date` when empty). */
  sessions?: ChartSession[];
  height?: number;
  loading?: boolean;
  emptyMessage?: string;
  ariaLabel?: string;
  className?: string;
}

const BASE_PAD = { top: 12, right: 8, bottom: 24, left: 8 };
/** Approximate width of one axis-label character (12px tabular digits); jsdom has no text metrics. */
const CHAR_W = 7.6;
/** Space between a y label and the plot. */
const LABEL_GAP = 8;
/** Below this width the chart uses inset axis labels and an inline readout. */
const COMPACT_WIDTH = 520;

/** Estimated pixel width of an axis label. */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * CHAR_W);
}

/**
 * Round y ticks (1 / 2 / 2.5 / 5 x 10^n steps) inside `[lo, hi]`, so labels
 * read "€96k, €98k, €100k" rather than "€96,378, €97,388".
 */
export function niceTicks(lo: number, hi: number, maxTicks = 5): number[] {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [lo];
  const ticksFor = (step: number) => {
    const out: number[] = [];
    for (let k = Math.ceil(lo / step); k * step <= hi + step * 1e-9; k++) out.push(Number((k * step).toPrecision(12)));
    return out;
  };
  const mag = 10 ** Math.floor(Math.log10(span));
  // Largest round step that still gives at least three ticks.
  for (const f of [5, 2.5, 2, 1, 0.5, 0.25, 0.2, 0.1, 0.05]) {
    const ticks = ticksFor(f * mag);
    if (ticks.length >= 3 && ticks.length <= maxTicks) return ticks;
  }
  return [lo, hi];
}

/** The label, or its first word ("Tue 27" -> "Tue") when it does not fit `maxPx`. */
export function fitLabel(label: string, maxPx: number): string {
  return labelWidth(label) <= maxPx ? label : label.split(" ")[0];
}

export function toTime(t: string | number): number {
  return typeof t === "number" ? t : Date.parse(t);
}

/** Split points into runs of consecutive non-null values (gaps break the line). */
export function segments(points: { x: number; y: number | null }[]): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push({ x: p.x, y: p.y });
  }
  if (cur.length) out.push(cur);
  return out;
}

const MINUTE = 60_000;
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360].map((m) => m * MINUTE);

/**
 * Intraday ticks on round clock times (multiples of the step since the epoch,
 * which are round local times in every whole/half-hour timezone).
 */
export function timeTicks(tMin: number, tMax: number, maxTicks: number): number[] {
  if (!(tMax > tMin)) return [tMin];
  const span = tMax - tMin;
  const step = TIME_STEPS.find((s) => span / s <= maxTicks) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const out: number[] = [];
  for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) out.push(t);
  return out.length ? out : [tMin, tMax];
}

function toneClass(tone: ChartTone | undefined, index: number): string {
  if (tone) return tone;
  return index === 0 ? "primary" : `n${((index - 1) % 4) + 1}`;
}

export function Chart({
  series,
  referenceLine,
  range,
  onRangeChange,
  ranges,
  valueFormat,
  timeFormat,
  tooltipTimeFormat,
  rangeLabel,
  headerExtra,
  xMode = "date",
  trend,
  busy = false,
  rightAxisFormat,
  onToggleSeries,
  sessions,
  height = 280,
  loading = false,
  emptyMessage = "No data for this range.",
  ariaLabel = "Value chart",
  className,
}: ChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  // The scrub position belongs to the data it was taken on: a new range or
  // series set drops it (no tooltip left hanging over a different chart).
  const [cursorState, setCursorState] = useState<{ i: number; key: string } | null>(null);
  const gradId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, series.length]);

  const model = useMemo(() => {
    const all = series.map((s, i) => {
      const k = s.scale && Number.isFinite(s.scale) && s.scale !== 0 ? s.scale : 1;
      return {
        ...s,
        toneCls: toneClass(s.tone, i),
        pts: s.points
          .map((p) => ({ x: toTime(p.t), y: p.v === null ? null : p.v / k, raw: p.v }))
          .filter((p) => Number.isFinite(p.x))
          .sort((a, b) => a.x - b.x),
      };
    });
    const prepared = all.filter((s) => !s.hidden);
    const times = [...new Set(prepared.flatMap((s) => s.pts.map((p) => p.x)))].sort((a, b) => a - b);
    const values = prepared
      .flatMap((s) => s.pts.map((p) => p.y))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    return { all, prepared, times, values };
  }, [series]);

  const { all, prepared, times, values } = model;
  const dataKey = `${range ?? ""}|${times.length}|${times[0] ?? ""}|${times[times.length - 1] ?? ""}`;
  const cursor = cursorState && cursorState.key === dataKey ? cursorState.i : null;
  const setCursor = useCallback(
    (i: number | null) => setCursorState(i === null ? null : { i, key: dataKey }),
    [dataKey],
  );
  // Narrow (phone) charts: axis labels sit inside the plot and the scrub
  // readout replaces the legend line, so the lines get the full width and
  // nothing floats over them.
  const compact = width < COMPACT_WIDTH;
  const rightSeries = rightAxisFormat ? prepared.find((s) => s.axis === "right") : undefined;
  const rightScale = rightSeries?.scale && Number.isFinite(rightSeries.scale) ? rightSeries.scale : 1;
  const bounds = useMemo(() => {
    if (!values.length) return null;
    const tMin = times[0];
    const tMax = times[times.length - 1];
    const ref = referenceLine && Number.isFinite(referenceLine.value) ? [referenceLine.value] : [];
    let lo = Math.min(...values, ...ref);
    let hi = Math.max(...values, ...ref);
    if (lo === hi) {
      lo -= Math.abs(lo) * 0.01 || 1;
      hi += Math.abs(hi) * 0.01 || 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    return { lo, hi, tMin, tMax };
  }, [values, times, referenceLine]);

  // Margins fit the widest tick label, so labels are never clipped and the plot
  // gets every remaining pixel (narrow phones especially).
  const yTicks = bounds ? niceTicks(bounds.lo, bounds.hi, height < 200 ? 4 : 5) : [];
  const leftW = Math.max(0, ...yTicks.map((v) => labelWidth(valueFormat(v))));
  const rightW =
    rightSeries && rightAxisFormat ? Math.max(0, ...yTicks.map((v) => labelWidth(rightAxisFormat(v * rightScale)))) : 0;
  const PAD = compact
    ? { top: 18, right: 2, bottom: 24, left: 2 }
    : {
        ...BASE_PAD,
        left: leftW + LABEL_GAP,
        right: rightW ? rightW + LABEL_GAP : BASE_PAD.right,
      };
  const innerW = Math.max(width - PAD.left - PAD.right, 10);
  const innerH = Math.max(height - PAD.top - PAD.bottom, 10);

  const scales = useMemo(() => {
    if (!bounds) return null;
    const { lo, hi, tMin, tMax } = bounds;
    const layout = xMode === "session" && sessions?.length ? sessionLayout(sessions, PAD.left, innerW) : null;
    const x = layout
      ? layout.x
      : (t: number) => PAD.left + (tMax === tMin ? innerW / 2 : ((t - tMin) / (tMax - tMin)) * innerW);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;
    return { x, y, lo, hi, tMin, tMax, layout };
  }, [bounds, innerW, innerH, PAD.left, PAD.top, xMode, sessions]);

  const setFromClientX = useCallback(
    (clientX: number) => {
      if (!scales || !times.length) return;
      const rect = wrapRef.current?.getBoundingClientRect();
      const local = Number.isFinite(clientX) ? clientX - (rect?.left ?? 0) : 0;
      const scale = rect && rect.width > 0 ? width / rect.width : 1;
      const px = local * scale;
      let best = 0;
      let bestD = Infinity;
      times.forEach((t, i) => {
        const d = Math.abs(scales.x(t) - px);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      setCursor(best);
    },
    [scales, times, width, setCursor],
  );

  function onPointer(e: PointerEvent<SVGSVGElement>) {
    setFromClientX(e.clientX);
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (!times.length) return;
    const last = times.length - 1;
    const cur = cursor ?? last;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(last, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setCursor(next);
  }

  const rangeControl =
    ranges && ranges.length > 0 && range !== undefined && onRangeChange ? (
      <SegmentedControl
        ariaLabel="Chart range"
        size="sm"
        options={ranges.map((r) => ({ value: r, label: rangeLabel ? rangeLabel(r) : r }))}
        value={range}
        onChange={onRangeChange}
      />
    ) : null;
  const header =
    rangeControl || headerExtra ? (
      <div className="chart__header">
        {headerExtra && <div className="chart__header-extra">{headerExtra}</div>}
        {rangeControl}
      </div>
    ) : null;

  if (loading) {
    return (
      <div className={clsx("chart", className)}>
        {header}
        <output className="chart__loading" aria-label="Loading chart">
          <Skeleton height={`${height}px`} />
        </output>
      </div>
    );
  }

  if (!scales) {
    return (
      <div className={clsx("chart", className)}>
        {header}
        <div className="chart__empty" style={{ minHeight: height }}>
          <EmptyState title={emptyMessage} />
        </div>
      </div>
    );
  }

  // As many x labels as fit side by side (at least the two ends).
  const xLabelW = Math.max(labelWidth(timeFormat(scales.tMin)), labelWidth(timeFormat(scales.tMax)));
  const xCount = Math.min(6, Math.max(2, Math.floor(innerW / (xLabelW + 24))));
  const layout = scales.layout;
  const xTicks = layout
    ? []
    : xMode === "time"
      ? timeTicks(scales.tMin, scales.tMax, xCount + 1)
      : Array.from({ length: xCount }, (_, i) => scales.tMin + ((scales.tMax - scales.tMin) * i) / (xCount - 1));
  const tipTime = tooltipTimeFormat ?? timeFormat;
  // End marker: last drawn point of the primary series.
  const primaryPts = (prepared[0]?.pts ?? []).flatMap((p) => (p.y === null ? [] : [{ x: p.x, y: p.y }]));
  const endPt = trend && primaryPts.length ? primaryPts[primaryPts.length - 1] : null;
  const cursorT = cursor !== null ? (times[cursor] ?? null) : null;
  const cursorX = cursorT !== null ? scales.x(cursorT) : null;
  const tipRows =
    cursorT !== null
      ? prepared.flatMap((s) => {
          const p = s.pts.find((q) => q.x === cursorT);
          return p && p.y !== null && p.raw !== null
            ? [
                {
                  id: s.id,
                  label: s.label,
                  tone: s.toneCls,
                  value: (s.valueFormat ?? valueFormat)(p.raw),
                  y: scales.y(p.y),
                },
              ]
            : [];
        })
      : [];
  const tipOnLeft = cursorX !== null && cursorX > width * 0.6;

  return (
    <div className={clsx("chart", trend && `chart--${trend}`, busy && "chart--busy", className)} aria-busy={busy || undefined}>
      {header}
      <div className="chart__wrap" ref={wrapRef} style={{ height }}>
        <svg
          className="chart__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setCursor(null)}
          // Touch: the readout shows while the finger is down, never after.
          onPointerUp={(e) => {
            if (e.pointerType !== "mouse") setCursor(null);
          }}
          onPointerCancel={() => setCursor(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setCursor(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="chart__grad-stop chart__grad-stop--top" />
              <stop offset="100%" className="chart__grad-stop chart__grad-stop--bottom" />
            </linearGradient>
          </defs>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="chart__grid" x1={PAD.left} x2={width - PAD.right} y1={scales.y(v)} y2={scales.y(v)} />
              <text
                className={clsx("chart__axis-label", compact ? "chart__axis-label--inset" : "chart__axis-label--y")}
                x={compact ? PAD.left + 2 : PAD.left - 8}
                y={compact ? scales.y(v) - 4 : scales.y(v)}
                dy={compact ? undefined : "0.32em"}
              >
                {valueFormat(v)}
              </text>
              {rightSeries && rightAxisFormat && (
                <text
                  className={clsx(
                    "chart__axis-label",
                    compact ? "chart__axis-label--inset chart__axis-label--inset-end" : "chart__axis-label--right",
                    `chart__axis-label--${rightSeries.toneCls}`,
                  )}
                  x={compact ? width - PAD.right - 2 : width - PAD.right + 8}
                  y={compact ? scales.y(v) - 4 : scales.y(v)}
                  dy={compact ? undefined : "0.32em"}
                >
                  {rightAxisFormat(v * rightScale)}
                </text>
              )}
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={t}
              className="chart__axis-label chart__axis-label--x"
              x={scales.x(t)}
              y={height - 6}
              textAnchor={
                xMode === "time" ? "middle" : i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"
              }
            >
              {timeFormat(t)}
            </text>
          ))}
          {layout?.bands.map((b, i) => (
            <g key={b.date} data-session={b.date}>
              {i > 0 && (
                <line className="chart__session-sep" x1={b.x0} x2={b.x0} y1={PAD.top} y2={PAD.top + innerH} />
              )}
              <text
                className="chart__axis-label chart__axis-label--x"
                x={(b.x0 + b.x1) / 2}
                y={height - 6}
                textAnchor="middle"
              >
                {fitLabel(timeFormat(b.open), b.x1 - b.x0 - 6)}
              </text>
            </g>
          ))}
          {referenceLine && Number.isFinite(referenceLine.value) && (
            <g className="chart__reference" data-reference>
              <line
                className="chart__reference-line"
                x1={PAD.left}
                x2={width - PAD.right}
                y1={scales.y(referenceLine.value)}
                y2={scales.y(referenceLine.value)}
              />
              {referenceLine.label && (
                <text
                  className="chart__reference-label"
                  x={width - PAD.right - 4}
                  y={scales.y(referenceLine.value) - 4}
                  textAnchor="end"
                >
                  {referenceLine.label}
                </text>
              )}
            </g>
          )}
          {prepared.map((s) => {
            // In session mode the line breaks between sessions (no overnight bridge).
            const mapped: { x: number; y: number | null }[] = [];
            let prevSession = -1;
            for (const p of s.pts) {
              const si = layout ? layout.index(p.x) : 0;
              if (layout && prevSession !== -1 && si !== prevSession) mapped.push({ x: NaN, y: null });
              prevSession = si;
              mapped.push({ x: scales.x(p.x), y: p.y === null ? null : scales.y(p.y) });
            }
            const runs = segments(mapped);
            const tone = s.toneCls;
            return (
              <g key={s.id} className={clsx("chart__series", `chart__series--${tone}`)} data-series={s.id}>
                {tone === "primary" &&
                  runs
                    .filter((r) => r.length > 1)
                    .map((r, k) => (
                      <path
                        key={`a${k}`}
                        className="chart__area"
                        fill={`url(#${gradId})`}
                        d={`M${r[0].x},${PAD.top + innerH} ${r.map((p) => `L${p.x},${p.y}`).join(" ")} L${r[r.length - 1].x},${PAD.top + innerH} Z`}
                      />
                    ))}
                {runs.map((r, k) =>
                  r.length === 1 ? (
                    <circle key={`d${k}`} className="chart__dot" cx={r[0].x} cy={r[0].y} r={2.5} />
                  ) : (
                    <path
                      key={`l${k}`}
                      className="chart__line"
                      d={r.map((p, j) => `${j ? "L" : "M"}${p.x},${p.y}`).join(" ")}
                    />
                  ),
                )}
              </g>
            );
          })}
          {endPt && (
            <path
              className="chart__end-marker"
              data-end-marker={trend}
              d={
                trend === "down"
                  ? `M${scales.x(endPt.x) - 5},${scales.y(endPt.y) - 4} L${scales.x(endPt.x) + 5},${scales.y(endPt.y) - 4} L${scales.x(endPt.x)},${scales.y(endPt.y) + 5} Z`
                  : trend === "up"
                    ? `M${scales.x(endPt.x) - 5},${scales.y(endPt.y) + 4} L${scales.x(endPt.x) + 5},${scales.y(endPt.y) + 4} L${scales.x(endPt.x)},${scales.y(endPt.y) - 5} Z`
                    : `M${scales.x(endPt.x) - 4},${scales.y(endPt.y)} a4,4 0 1,0 8,0 a4,4 0 1,0 -8,0`
              }
            />
          )}
          {cursorX !== null && (
            <g className="chart__cursor" pointerEvents="none">
              <line className="chart__crosshair" x1={cursorX} x2={cursorX} y1={PAD.top} y2={PAD.top + innerH} />
              {tipRows.map((r) => (
                <circle
                  key={r.id}
                  className={clsx("chart__marker", `chart__marker--${r.tone}`)}
                  cx={cursorX}
                  cy={r.y}
                  r={4}
                />
              ))}
            </g>
          )}
        </svg>
        {!compact && cursorX !== null && cursorT !== null && (
          <output
            className={clsx("chart__tooltip", tipOnLeft && "chart__tooltip--left")}
            style={{ left: cursorX, top: PAD.top }}
          >
            <div className="chart__tooltip-time">{tipTime(cursorT)}</div>
            {tipRows.map((r) => (
              <div key={r.id} className="chart__tooltip-row">
                <span className={clsx("chart__swatch", `chart__swatch--${r.tone}`)} aria-hidden />
                <span className="chart__tooltip-label">{r.label}</span>
                <span className="chart__tooltip-value">{r.value}</span>
              </div>
            ))}
          </output>
        )}
      </div>
      {compact && cursorT !== null ? (
        <output className="chart__readout">
          <span className="chart__readout-time">{tipTime(cursorT)}</span>
          {tipRows.map((r) => (
            <span key={r.id} className="chart__readout-item">
              <span className={clsx("chart__swatch", `chart__swatch--${r.tone}`)} aria-hidden />
              <span className="chart__readout-value">{r.value}</span>
            </span>
          ))}
        </output>
      ) : all.length > 1 ? (
        <ul className="chart__legend">
          {all.map((s) => {
            const swatch = <span className={clsx("chart__swatch", `chart__swatch--${s.toneCls}`)} aria-hidden />;
            return (
              <li key={s.id} className={clsx("chart__legend-item", s.hidden && "chart__legend-item--off")}>
                {onToggleSeries ? (
                  <button
                    type="button"
                    className="chart__legend-toggle"
                    aria-pressed={!s.hidden}
                    onClick={() => onToggleSeries(s.id)}
                  >
                    {swatch}
                    {s.label}
                  </button>
                ) : (
                  <>
                    {swatch}
                    {s.label}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : compact ? (
        // Same height as the readout, so scrubbing never moves the page.
        <div className="chart__readout chart__readout--idle" aria-hidden />
      ) : null}
    </div>
  );
}
