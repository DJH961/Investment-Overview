/* The plot is a custom scrubbable graphic: an svg that takes focus, arrow keys and pointer input. */
/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role */
import clsx from "clsx";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { EmptyState } from "../EmptyState";
import { SegmentedControl } from "../SegmentedControl";
import { Skeleton } from "../Skeleton";
import "./Chart.scss";

export type ChartTone = "primary" | "benchmark" | "muted";

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
}

export interface ChartProps {
  series: ChartSeries[];
  range?: string;
  onRangeChange?: (range: string) => void;
  ranges?: string[];
  valueFormat: (v: number) => string;
  timeFormat: (t: number) => string;
  height?: number;
  loading?: boolean;
  emptyMessage?: string;
  ariaLabel?: string;
  className?: string;
}

const PAD = { top: 12, right: 12, bottom: 24, left: 56 };

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

function toneClass(tone: ChartTone | undefined, index: number): string {
  if (tone) return tone;
  return index === 0 ? "primary" : `n${((index - 1) % 4) + 1}`;
}

export function Chart({
  series,
  range,
  onRangeChange,
  ranges,
  valueFormat,
  timeFormat,
  height = 280,
  loading = false,
  emptyMessage = "No data for this range.",
  ariaLabel = "Value chart",
  className,
}: ChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [cursor, setCursor] = useState<number | null>(null);
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
    const prepared = series.map((s) => ({
      ...s,
      pts: s.points
        .map((p) => ({ x: toTime(p.t), y: p.v }))
        .filter((p) => Number.isFinite(p.x))
        .sort((a, b) => a.x - b.x),
    }));
    const times = [...new Set(prepared.flatMap((s) => s.pts.map((p) => p.x)))].sort((a, b) => a - b);
    const values = prepared
      .flatMap((s) => s.pts.map((p) => p.y))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    return { prepared, times, values };
  }, [series]);

  const { prepared, times, values } = model;
  const innerW = Math.max(width - PAD.left - PAD.right, 10);
  const innerH = Math.max(height - PAD.top - PAD.bottom, 10);

  const scales = useMemo(() => {
    if (!values.length) return null;
    const tMin = times[0];
    const tMax = times[times.length - 1];
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (lo === hi) {
      lo -= Math.abs(lo) * 0.01 || 1;
      hi += Math.abs(hi) * 0.01 || 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const x = (t: number) => PAD.left + (tMax === tMin ? innerW / 2 : ((t - tMin) / (tMax - tMin)) * innerW);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;
    return { x, y, lo, hi, tMin, tMax };
  }, [values, times, innerW, innerH]);

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
    [scales, times, width],
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

  const header =
    ranges && ranges.length > 0 && range !== undefined && onRangeChange ? (
      <div className="chart__header">
        <SegmentedControl
          ariaLabel="Chart range"
          size="sm"
          options={ranges.map((r) => ({ value: r, label: r }))}
          value={range}
          onChange={onRangeChange}
        />
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

  const yTicks = Array.from({ length: 5 }, (_, i) => scales.lo + ((scales.hi - scales.lo) * i) / 4);
  const xCount = width < 420 ? 3 : 5;
  const xTicks = Array.from(
    { length: xCount },
    (_, i) => scales.tMin + ((scales.tMax - scales.tMin) * i) / (xCount - 1),
  );
  const cursorT = cursor !== null ? (times[cursor] ?? null) : null;
  const cursorX = cursorT !== null ? scales.x(cursorT) : null;
  const tipRows =
    cursorT !== null
      ? prepared.flatMap((s, i) => {
          const p = s.pts.find((q) => q.x === cursorT);
          return p && p.y !== null
            ? [
                {
                  id: s.id,
                  label: s.label,
                  tone: toneClass(s.tone, i),
                  value: valueFormat(p.y),
                  y: scales.y(p.y),
                },
              ]
            : [];
        })
      : [];
  const tipOnLeft = cursorX !== null && cursorX > width * 0.6;

  return (
    <div className={clsx("chart", className)}>
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
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setCursor(null);
          }}
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
              <text className="chart__axis-label chart__axis-label--y" x={PAD.left - 8} y={scales.y(v)} dy="0.32em">
                {valueFormat(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={t}
              className="chart__axis-label chart__axis-label--x"
              x={scales.x(t)}
              y={height - 6}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            >
              {timeFormat(t)}
            </text>
          ))}
          {prepared.map((s, i) => {
            const runs = segments(
              s.pts.map((p) => ({
                x: scales.x(p.x),
                y: p.y === null ? null : scales.y(p.y),
              })),
            );
            const tone = toneClass(s.tone, i);
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
        {cursorX !== null && cursorT !== null && (
          <output
            className={clsx("chart__tooltip", tipOnLeft && "chart__tooltip--left")}
            style={{ left: cursorX, top: PAD.top }}
          >
            <div className="chart__tooltip-time">{timeFormat(cursorT)}</div>
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
      {prepared.length > 1 && (
        <ul className="chart__legend">
          {prepared.map((s, i) => (
            <li key={s.id} className="chart__legend-item">
              <span className={clsx("chart__swatch", `chart__swatch--${toneClass(s.tone, i)}`)} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
