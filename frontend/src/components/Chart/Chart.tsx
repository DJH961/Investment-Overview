/* The plot is a custom scrubbable graphic: an svg that takes focus, arrow keys and pointer input. */
/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role */
import clsx from "clsx";
import {
  useCallback,
  useId,
  useLayoutEffect,
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

/**
 * `invested`: a dashed muted guide line; `estimate`: the dashed twin-estimate line;
 * `ink`: a dashed line in the text color (a "what it would have been" reference, such
 * as the constant-currency value next to the actual one).
 */
export type ChartTone = "primary" | "benchmark" | "muted" | "invested" | "estimate" | "ink";

/**
 * A point mark on the plot: a trade (▲ buy / ▼ sell, the shape carries the meaning), a
 * small dot (a NAV print), or a currency conversion: `conversion` is a neutral ring
 * sized by `r`, `above` / `below` a ▲ / ▼ against a reference rate (shape and color,
 * each with an ink outline so it stands off the line). Not part of the scrub; its label
 * is its accessible name.
 */
export interface ChartMarker {
  t: string | number;
  v: number;
  /** `rug`: a quiet tick on the date axis (its `v` is ignored and not part of the y range). */
  shape: "buy" | "sell" | "dot" | "conversion" | "above" | "below" | "rug";
  label: string;
  /** Size in px (conversion markers: by amount). Default 3.5 for dots and rings, 5 for triangles. */
  r?: number;
}

/**
 * A hatched band between two series (`upper` minus `lower`, by series id): the gap that
 * one cause explains, such as the currency effect between the actual value and the value
 * at a frozen rate. Where `upper` is above `lower` the hatch leans one way (`/`), below
 * it the other (`\`), so the side reads from the shape, not only the color.
 */
export interface ChartBand {
  upper: string;
  lower: string;
  /** Legend label; the hatched swatch is shown when set. */
  label?: string;
}

export interface BandPolygon {
  side: "up" | "down";
  d: string;
}

/**
 * Splits the area between two lines into polygons where one is above / below the other,
 * cutting at each crossing. Points are pixel coordinates sharing x (the same times); a
 * value of null breaks the band. y grows downwards, so "up" means `a` is drawn higher.
 */
export function bandPolygons(rows: { x: number; a: number | null; b: number | null }[]): BandPolygon[] {
  const out: BandPolygon[] = [];
  let run: { x: number; a: number; b: number }[] = [];
  let side: "up" | "down" | null = null;
  const flush = () => {
    if (run.length > 1 && side) {
      const top = run.map((p, i) => `${i ? "L" : "M"}${p.x},${p.a}`).join(" ");
      const back = [...run].reverse().map((p) => `L${p.x},${p.b}`).join(" ");
      out.push({ side, d: `${top} ${back} Z` });
    }
    run = [];
    side = null;
  };
  const sideOf = (a: number, b: number): "up" | "down" | null => (a < b ? "up" : a > b ? "down" : null);
  for (const p of rows) {
    if (p.a === null || p.b === null || !Number.isFinite(p.a) || !Number.isFinite(p.b) || !Number.isFinite(p.x)) {
      flush();
      continue;
    }
    const cur = { x: p.x, a: p.a, b: p.b };
    const s = sideOf(cur.a, cur.b);
    const prev = run[run.length - 1];
    if (prev && side && s && s !== side) {
      // Crossing between prev and cur: close this run at the meeting point, start the next there.
      const d0 = prev.a - prev.b;
      const d1 = cur.a - cur.b;
      const f = d0 / (d0 - d1);
      const meet = { x: prev.x + f * (cur.x - prev.x), a: prev.a + f * (cur.a - prev.a), b: 0 };
      meet.b = meet.a;
      run.push(meet);
      flush();
      run = [meet, cur];
      side = s;
      continue;
    }
    run.push(cur);
    if (!side && s) side = s;
  }
  flush();
  return out;
}

/**
 * x axis layout: evenly spaced dates (default), clock-aligned intraday ticks, or
 * `session`: each exchange session an equal band (nights/weekends squeezed out).
 */
export type ChartXMode = "date" | "time" | "session";

/** One exchange session (UTC instants) for `xMode="session"`. */
/** Share of the x-span added after the last point when a "now" marker is shown. */
const NOW_GUTTER = 0.05;

/**
 * The first text baseline (`y + offset`) whose ~12 px label band misses every inset
 * axis label (drawn just above its tick line). Falls back to the first offset.
 */
export function freeLabelY(y: number, offsets: number[], tickYs: number[]): number {
  for (const off of offsets) {
    const top = y + off - 12;
    const bottom = y + off;
    if (tickYs.every((t) => bottom < t - 16 || top > t - 2)) return y + off;
  }
  return y + offsets[0];
}

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

/** Direction of the primary line versus its reference (colors line, area and end marker). */
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

/**
 * A horizontal guide at a fixed value (e.g. cost basis).
 * `softBounds`:
 * - `false` / omitted: always include `value` in y-axis bounds.
 * - `true`: include `value` only if near the plotted data; otherwise show a pinned edge cue.
 * - `"strict"`: never expand y-axis bounds to reach `value`; draw the line only if it already fits.
 */
export interface ChartReferenceLine {
  value: number;
  label?: string;
  softBounds?: boolean | "strict";
  /** Display string for the off-scale edge cue (defaults to `valueFormat(value)`). */
  formattedValue?: string;
}

/** Whether `refValue` sits close enough to `[dataLo, dataHi]` not to flatten the curve. */
export function isReferenceInSoftBounds(refValue: number, dataLo: number, dataHi: number): boolean {
  const span = Math.max(dataHi - dataLo, Math.abs(dataHi) * 0.01, 1e-6);
  return refValue >= dataLo - span * 1.5 && refValue <= dataHi + span * 1.5;
}

/**
 * One live marker (dot + label) at a value just after the line ends; nothing joins
 * them. It sits a fixed small step to the right of the last point rather than at its
 * wall-clock time, so the axis keeps the session and is not stretched over the night.
 */
export interface ChartNowMarker {
  v: number;
  /** Label lines, drawn to the left of the dot (first line = the value). */
  lines?: string[];
}

export interface ChartProps {
  series: ChartSeries[];
  referenceLine?: ChartReferenceLine;
  nowMarker?: ChartNowMarker;
  /** Trade or NAV marks drawn over the lines (part of the y range). */
  markers?: ChartMarker[];
  /** A hatched gap band between two of the series (drawn under the lines). */
  band?: ChartBand;
  /** One extra tooltip / readout line for the scrubbed time (e.g. the gap between two lines). */
  tooltipExtra?: (t: number) => string | null;
  range?: string;
  onRangeChange?: (range: string) => void;
  ranges?: string[];
  /** Left-axis labels and the tooltip default. On the axis `step` is the tick spacing, so
   *  a formatter can show just enough digits for neighboring ticks to differ. */
  valueFormat: (v: number, step?: number) => string;
  /** Axis tick labels. */
  timeFormat: (t: number) => string;
  /** Tooltip time label (default: `timeFormat`). */
  tooltipTimeFormat?: (t: number) => string;
  /** Range button labels (default: the range id). */
  rangeLabel?: (range: string) => string;
  /** Extra content in the header row, left of the range control (growth, reload). */
  headerExtra?: ReactNode;
  /** A note at the right end of the legend row (same line as the series chips). */
  legendExtra?: ReactNode;
  xMode?: ChartXMode;
  /** Colors the primary series green/red and draws a ▲/▼ end marker. */
  trend?: ChartTrend;
  /** Keep the drawn curve but dim it while new data loads. */
  busy?: boolean;
  /** Right-axis tick labels for a scaled `axis: "right"` series (true values in its currency). */
  /** Right-axis labels; `step` is the tick spacing (in right-axis units). */
  rightAxisFormat?: (v: number, step?: number) => string;
  /**
   * A right axis with no line of its own: the left ticks × `scale`, in another unit (the
   * twin chart's "≈ fund estimate" beside the twin's price). Shown on phones too (inset).
   */
  rightAxis?: { scale: number; format: (v: number) => string };
  /** Makes legend entries toggle buttons. */
  onToggleSeries?: (id: string) => void;
  /** Exchange sessions for `xMode="session"` (falls back to `date` when empty). */
  sessions?: ChartSession[];
  /** Time spans shaded behind the lines (e.g. the US stock market's open hours), UTC instants. */
  shade?: { from: string | number; to: string | number }[];
  /** Session mode: keep one line across a market break (the divider still marks it). Spot FX over the weekend. */
  joinSessions?: boolean;
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
/**
 * A second (right) y axis needs a card this wide; below it the reporting currency's
 * axis stands alone and the other currency is read from the tooltip and the legend.
 */
const TWO_AXIS_WIDTH = 720;
/** Right gutter kept on a two-currency chart whether or not the right labels are drawn, so the plot never moves. */
const RIGHT_GUTTER = 64;

/**
 * A clock tick pushed inward at an edge can run into its neighbor ("19:00 20:00"): the
 * edge label then gives way, the neighbor already says the hour.
 */
export function crowdsPrevious(
  ticks: number[],
  i: number,
  x: (t: number) => number,
  w: (t: number) => number,
  left: number,
  right: number,
): boolean {
  if (i === 0 || i !== ticks.length - 1) return false;
  const xi = x(ticks[i]);
  const wi = w(ticks[i]);
  const start = timeAnchor(xi, wi, left, right) === "end" ? xi - wi : xi - wi / 2;
  const prev = ticks[i - 1];
  return start < x(prev) + w(prev) / 2 + 8;
}

/** A clock tick near a plot edge is anchored inward, so its label never runs off the card. */
export function timeAnchor(x: number, w: number, left: number, right: number): "start" | "middle" | "end" {
  if (x + w / 2 > right) return "end";
  if (x - w / 2 < left) return "start";
  return "middle";
}

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

/** An equilateral-ish triangle centred on the point: ▲ (`up`) or ▼, `r` its half-width. */
function triangle(x: number, y: number, r: number, up: boolean): string {
  const h = r * 0.9;
  return up
    ? `M${x - r},${y + h} L${x + r},${y + h} L${x},${y - h} Z`
    : `M${x - r},${y - h} L${x + r},${y - h} L${x},${y + h} Z`;
}

function toneClass(tone: ChartTone | undefined, index: number): string {
  if (tone) return tone;
  return index === 0 ? "primary" : `n${((index - 1) % 4) + 1}`;
}

export function Chart({
  series,
  referenceLine,
  nowMarker,
  markers,
  band,
  tooltipExtra,
  range,
  onRangeChange,
  ranges,
  valueFormat,
  timeFormat,
  tooltipTimeFormat,
  rangeLabel,
  headerExtra,
  legendExtra,
  xMode = "date",
  trend,
  busy = false,
  rightAxisFormat,
  rightAxis,
  onToggleSeries,
  sessions,
  shade,
  joinSessions = false,
  height = 280,
  loading = false,
  emptyMessage = "No data for this range.",
  ariaLabel = "Value chart",
  className,
}: ChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The plot box mounts only once there is data, so it is tracked through a callback ref:
  // a chart that first renders empty still follows its width when data arrives.
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const attachWrap = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el;
    setWrapEl(el);
  }, []);
  const [width, setWidth] = useState(600);
  // The scrub position belongs to the data it was taken on: a new range or
  // series set drops it (no tooltip left hanging over a different chart).
  const [cursorState, setCursorState] = useState<{ i: number; key: string } | null>(null);
  const gradId = useId();

  // Measured before the first paint, so a phone never flashes a 600 px layout.
  useLayoutEffect(() => {
    const el = wrapEl;
    if (!el) return;
    const w0 = el.getBoundingClientRect().width;
    // Measured here, before paint, on purpose: a phone must not flash a 600 px layout.
    // oxlint-disable-next-line react/set-state-in-effect
    if (w0 > 0) setWidth(w0);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrapEl]);

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
  // Identifies the chart the scrub belongs to: the range, the first sample and which series
  // are drawn. Deliberately NOT the length or last time, so a live sample appended at the
  // end keeps the hover where it is (indexes of earlier samples do not move).
  const dataKey = `${range ?? ""}|${times[0] ?? ""}|${prepared.map((s) => s.id).join(",")}`;
  const cursor =
    cursorState && cursorState.key === dataKey && cursorState.i < times.length ? cursorState.i : null;
  const setCursor = useCallback(
    (i: number | null) => setCursorState(i === null ? null : { i, key: dataKey }),
    [dataKey],
  );
  // Narrow (phone) charts: axis labels sit inside the plot and the scrub
  // readout replaces the legend line, so the lines get the full width and
  // nothing floats over them.
  const compact = width < COMPACT_WIDTH;
  const rightSeries = rightAxisFormat ? prepared.find((s) => s.axis === "right") : undefined;
  const rightFmt = rightSeries ? rightAxisFormat : rightAxis?.format;
  const hasRight = !!rightSeries || !!rightAxis;
  const rightScale = rightSeries
    ? rightSeries.scale && Number.isFinite(rightSeries.scale)
      ? rightSeries.scale
      : 1
    : rightAxis && Number.isFinite(rightAxis.scale)
      ? rightAxis.scale
      : 1;
  const bounds = useMemo(() => {
    if (!values.length) return null;
    const nowOk = nowMarker && Number.isFinite(nowMarker.v);
    const tMin = times[0];
    const tLast = times[times.length - 1];
    // Room for the marker: a small gutter after the last point, never the night.
    const tMax = nowOk ? tLast + Math.max(tLast - tMin, 1) * NOW_GUTTER : tLast;
    const dataRefs = [
      ...(markers ?? []).filter((m) => m.shape !== "rug").map((m) => m.v).filter((v) => Number.isFinite(v)),
      ...(nowOk ? [nowMarker.v] : []),
    ];
    const dataLo = Math.min(...values, ...dataRefs);
    const dataHi = Math.max(...values, ...dataRefs);
    const refOk = referenceLine != null && Number.isFinite(referenceLine.value);
    const includeRef =
      refOk &&
      (referenceLine.softBounds === true
        ? isReferenceInSoftBounds(referenceLine.value, dataLo, dataHi)
        : referenceLine.softBounds !== "strict");
    let lo = includeRef ? Math.min(dataLo, referenceLine.value) : dataLo;
    let hi = includeRef ? Math.max(dataHi, referenceLine.value) : dataHi;
    if (lo === hi) {
      lo -= Math.abs(lo) * 0.01 || 1;
      hi += Math.abs(hi) * 0.01 || 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const refOffScale: "above" | "below" | null = !refOk
      ? null
      : referenceLine.value > hi
        ? "above"
        : referenceLine.value < lo
          ? "below"
          : null;
    return { lo, hi, tMin, tMax, refOffScale };
  }, [values, times, referenceLine, nowMarker, markers]);
  const nowX = bounds && nowMarker ? bounds.tMin + (bounds.tMax - bounds.tMin) * (1 - NOW_GUTTER / 2.5) : null;

  // Margins fit the widest tick label, so labels are never clipped and the plot
  // gets every remaining pixel (narrow phones especially).
  const yTicks = bounds ? niceTicks(bounds.lo, bounds.hi, height < 200 ? 4 : 5) : [];
  const yStep = yTicks.length > 1 ? Math.abs(yTicks[1] - yTicks[0]) : undefined;
  const leftW = Math.max(0, ...yTicks.map((v) => labelWidth(valueFormat(v, yStep))));
  const rightW =
    hasRight && rightFmt
      ? Math.max(0, ...yTicks.map((v) => labelWidth(rightFmt(v * rightScale, yStep && yStep * rightScale))))
      : 0;
  // The gutter is reserved by the width alone, so the plot is the same size with or
  // without the right labels (and across currencies and ranges).
  const showRightAxis = hasRight && !!rightFmt && (width >= TWO_AXIS_WIDTH || !!rightAxis);
  const PAD = compact
    ? { top: 18, right: 2, bottom: 24, left: 2 }
    : {
        ...BASE_PAD,
        left: leftW + LABEL_GAP,
        right: hasRight ? Math.max(RIGHT_GUTTER, rightW + LABEL_GAP) : BASE_PAD.right,
      };
  const innerW = Math.max(width - PAD.left - PAD.right, 10);
  const innerH = Math.max(height - PAD.top - PAD.bottom, 10);

  const scales = useMemo(() => {
    if (!bounds) return null;
    const { lo, hi, tMin, tMax, refOffScale } = bounds;
    const layout = xMode === "session" && sessions?.length ? sessionLayout(sessions, PAD.left, innerW) : null;
    const x = layout
      ? layout.x
      : (t: number) => PAD.left + (tMax === tMin ? innerW / 2 : ((t - tMin) / (tMax - tMin)) * innerW);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;
    return { x, y, lo, hi, tMin, tMax, refOffScale, layout };
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
  // Phone charts draw the axis labels inside the plot; a marker or reference label
  // that would land on one moves to a free spot instead of sitting on top of it.
  const insetTickYs = compact && scales ? yTicks.map((v) => scales.y(v)) : [];

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
  // The trend triangle marks where the line ends. After the close the "now" dot is the
  // end (the line stops at the close, and the day can have turned since), so no triangle.
  const endPt = trend && !nowMarker && primaryPts.length ? primaryPts[primaryPts.length - 1] : null;
  // End label: the primary series' last value in a small pill (identity = its dot, text = fg).
  // Only on a single-axis chart with no "now" marker, so it never stacks on another label.
  const primarySeries = prepared.find((s) => s.toneCls === "primary");
  const lastRaw = primarySeries
    ? [...primarySeries.pts].reverse().find((p) => p.y !== null && p.raw !== null)
    : undefined;
  let endPill: { x: number; y: number; w: number; text: string } | null = null;
  if (!compact && !nowMarker && !hasRight && primarySeries && lastRaw && lastRaw.y !== null && lastRaw.raw !== null) {
    const text = (primarySeries.valueFormat ?? valueFormat)(lastRaw.raw);
    const w = labelWidth(text) + 24;
    const ex = scales.x(lastRaw.x);
    const ey = scales.y(lastRaw.y);
    const px = Math.min(Math.max(ex - w, PAD.left), width - PAD.right - w);
    const topLimit = scales.refOffScale === "above" ? PAD.top + 22 : PAD.top;
    const bottomLimit = PAD.top + innerH - (scales.refOffScale === "below" ? 24 : 0);
    let py = ey + 30 <= bottomLimit ? ey + 12 : ey - 30;
    if (py < topLimit && ey + 30 <= PAD.top + innerH) py = ey + 12;
    endPill = { x: px, y: py, w, text };
  }
  let offScalePill: { x: number; y: number; w: number; text: string } | null = null;
  if (referenceLine && Number.isFinite(referenceLine.value) && scales.refOffScale) {
    const dir = scales.refOffScale;
    const text = `${dir === "above" ? "↑" : "↓"} ${referenceLine.label ? `${referenceLine.label} ` : ""}${referenceLine.formattedValue ?? valueFormat(referenceLine.value)}`;
    const w = Math.min(Math.max(innerW - 4, 40), labelWidth(text) + 14);
    const anchorY = dir === "above" ? PAD.top + 14 : PAD.top + innerH - 7;
    const textY =
      compact && showRightAxis
        ? freeLabelY(anchorY, dir === "above" ? [0, 18, 36] : [0, -18, -36], insetTickYs)
        : anchorY;
    offScalePill = { x: width - PAD.right - 4 - w, y: textY - 13, w, text };
  }
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
  const tipExtra = cursorT !== null && tooltipExtra ? tooltipExtra(cursorT) : null;
  // The gap band: both series at the same instants (a time missing from one breaks it).
  const bandUpper = band ? prepared.find((s) => s.id === band.upper) : undefined;
  const bandLower = band ? prepared.find((s) => s.id === band.lower) : undefined;
  const bandPolys =
    bandUpper && bandLower
      ? (() => {
          const lower = new Map(bandLower.pts.map((p) => [p.x, p.y]));
          return bandPolygons(
            bandUpper.pts.map((p) => {
              const b = lower.get(p.x);
              return {
                x: scales.x(p.x),
                a: p.y === null ? null : scales.y(p.y),
                b: b === null || b === undefined ? null : scales.y(b),
              };
            }),
          );
        })()
      : [];
  const tipOnLeft = cursorX !== null && cursorX > width * 0.6;

  return (
    <div className={clsx("chart", trend && `chart--${trend}`, busy && "chart--busy", className)} aria-busy={busy || undefined}>
      {header}
      <div className="chart__wrap" ref={attachWrap} style={{ height }}>
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
            {band && (
              <>
                <pattern id={`${gradId}-up`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line className="chart__band-hatch" x1={0} y1={0} x2={0} y2={6} />
                </pattern>
                <pattern id={`${gradId}-down`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                  <line className="chart__band-hatch" x1={0} y1={0} x2={0} y2={6} />
                </pattern>
              </>
            )}
          </defs>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="chart__grid" x1={PAD.left} x2={width - PAD.right} y1={scales.y(v)} y2={scales.y(v)} />
              {!compact && (
                <>
              <text
                className={clsx("chart__axis-label", compact ? "chart__axis-label--inset" : "chart__axis-label--y")}
                x={compact ? PAD.left + 2 : PAD.left - 8}
                y={compact ? scales.y(v) - 4 : scales.y(v)}
                dy={compact ? undefined : "0.32em"}
              >
                {valueFormat(v, yStep)}
              </text>
              {showRightAxis && rightFmt && (
                <text
                  className={clsx(
                    "chart__axis-label",
                    compact ? "chart__axis-label--inset chart__axis-label--inset-end" : "chart__axis-label--right",
                    `chart__axis-label--${rightSeries?.toneCls ?? "estimate"}`,
                  )}
                  x={compact ? width - PAD.right - 2 : width - PAD.right + 8}
                  y={compact ? scales.y(v) - 4 : scales.y(v)}
                  dy={compact ? undefined : "0.32em"}
                >
                  {rightFmt(v * rightScale, yStep && yStep * rightScale)}
                </text>
              )}
                </>
              )}
            </g>
          ))}
          <line
            className="chart__baseline"
            x1={PAD.left}
            x2={width - PAD.right}
            y1={PAD.top + innerH}
            y2={PAD.top + innerH}
          />
          {xTicks.map((t, i) => xMode === "time" && crowdsPrevious(xTicks, i, scales.x, (v) => labelWidth(timeFormat(v)), PAD.left, width - PAD.right) ? null : (
            <text
              key={t}
              className="chart__axis-label chart__axis-label--x"
              x={scales.x(t)}
              y={height - 6}
              textAnchor={
                xMode === "time" ? timeAnchor(scales.x(t), labelWidth(timeFormat(t)), PAD.left, width - PAD.right) : i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"
              }
            >
              {timeFormat(t)}
            </text>
          ))}
          {shade?.map((s) => {
            const lo = PAD.left;
            const hi = width - PAD.right;
            const x0 = Math.min(hi, Math.max(lo, scales.x(toTime(s.from))));
            const x1 = Math.min(hi, Math.max(lo, scales.x(toTime(s.to))));
            return x1 - x0 < 0.5 ? null : (
              <rect
                key={`${s.from}`}
                className="chart__shade"
                data-shade
                x={x0}
                y={PAD.top}
                width={x1 - x0}
                height={innerH}
              />
            );
          })}
          {layout?.bands.map((b, i, all) => (
            <g key={b.date} data-session={b.date}>
              {/* A divider only where the market really shut: back-to-back sessions (spot FX
                  trades Sunday evening to Friday evening without a break) run on unbroken. */}
              {i > 0 && b.open > all[i - 1].close && (
                <line className="chart__session-sep" x1={b.x0} x2={b.x0} y1={PAD.top} y2={PAD.top + innerH} />
              )}
              <text
                className="chart__axis-label chart__axis-label--x"
                x={(b.x0 + b.x1) / 2}
                y={height - 6}
                textAnchor="middle"
              >
                {/* Named by its middle: a forex day opens the evening before (Monday's on Sunday). */}
                {fitLabel(timeFormat((b.open + b.close) / 2), b.x1 - b.x0 - 6)}
              </text>
            </g>
          ))}
          {referenceLine && Number.isFinite(referenceLine.value) && scales.refOffScale === null && (
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
                  y={freeLabelY(scales.y(referenceLine.value), [-4, 13], insetTickYs)}
                  textAnchor="end"
                >
                  {referenceLine.label}
                </text>
              )}
            </g>
          )}
          {bandPolys.length > 0 && (
            <g className="chart__band" data-band>
              {bandPolys.map((p, k) => (
                <path
                  key={k}
                  className={clsx("chart__band-area", `chart__band-area--${p.side}`)}
                  data-band-side={p.side}
                  fill={`url(#${gradId}-${p.side})`}
                  d={p.d}
                />
              ))}
            </g>
          )}
          {prepared.map((s) => {
            // In session mode the line breaks where the market shut (no overnight or weekend
            // bridge); back-to-back sessions (spot FX on weekdays) keep one unbroken line.
            const mapped: { x: number; y: number | null }[] = [];
            let prevSession = -1;
            for (const p of s.pts) {
              const si = layout ? layout.index(p.x) : 0;
              const shut =
                !joinSessions &&
                layout &&
                prevSession !== -1 &&
                si !== prevSession &&
                (si !== prevSession + 1 || layout.bands[si].open > layout.bands[prevSession].close);
              if (shut) mapped.push({ x: NaN, y: null });
              prevSession = si;
              mapped.push({ x: scales.x(p.x), y: p.y === null ? null : scales.y(p.y) });
            }
            const runs = segments(mapped);
            const tone = s.toneCls;
            return (
              <g key={s.id} className={clsx("chart__series", `chart__series--${tone}`)} data-series={s.id}>
                {tone === "primary" &&
                  // A hatched band is the fill; a gradient under it would muddy it.
                  bandPolys.length === 0 &&
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
          {markers && markers.length > 0 && (
            <g className="chart__marks" data-markers>
              {markers.map((m, k) => {
                const mt = toTime(m.t);
                if (!Number.isFinite(mt) || !Number.isFinite(m.v)) return null;
                const mx = scales.x(mt);
                if (m.shape === "rug") {
                  const base = PAD.top + innerH;
                  const h = m.r ?? 6;
                  return (
                    <g key={`${k}-${mt}`} className="chart__mark chart__mark--rug" data-mark="rug">
                      <title>{m.label}</title>
                      <rect className="chart__rug-hit" x={mx - 4} y={base - 14} width={8} height={14} />
                      <line className="chart__rug" x1={mx} x2={mx} y1={base - h} y2={base} />
                    </g>
                  );
                }
                const my = scales.y(m.v);
                return (
                  <g key={`${k}-${mt}`} className={clsx("chart__mark", `chart__mark--${m.shape}`)} data-mark={m.shape}>
                    <title>{m.label}</title>
                    {m.shape === "dot" || m.shape === "conversion" ? (
                      <circle cx={mx} cy={my} r={m.r ?? 3.5} />
                    ) : m.shape === "above" || m.shape === "below" ? (
                      <path d={triangle(mx, my, m.r ?? 5, m.shape === "above")} />
                    ) : m.shape === "buy" ? (
                      <path d={`M${mx - 5},${my + 9} L${mx + 5},${my + 9} L${mx},${my + 2} Z`} />
                    ) : (
                      <path d={`M${mx - 5},${my - 9} L${mx + 5},${my - 9} L${mx},${my - 2} Z`} />
                    )}
                  </g>
                );
              })}
            </g>
          )}
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
          {nowMarker && nowX !== null && Number.isFinite(nowMarker.v) && (
            <g className="chart__now" data-now-marker>
              <circle className="chart__now-dot" cx={scales.x(nowX)} cy={scales.y(nowMarker.v)} r={5} />
              {(nowMarker.lines ?? []).map((line, k, all) => (
                <text
                  key={line}
                  className={clsx("chart__now-label", k > 0 && "chart__now-label--sub")}
                  x={scales.x(nowX) - 9}
                  y={
                    freeLabelY(scales.y(nowMarker.v), [4, 18, -10], insetTickYs) +
                    (k - (all.length - 1)) * 14
                  }
                  textAnchor="end"
                >
                  {line}
                </text>
              ))}
            </g>
          )}
          {endPill && (
            <g className="chart__end-pill" data-end-pill pointerEvents="none">
              <rect className="chart__end-pill-box" x={endPill.x} y={endPill.y} width={endPill.w} height={18} rx={9} />
              <circle className="chart__end-pill-dot" cx={endPill.x + 9} cy={endPill.y + 9} r={3} />
              <text className="chart__end-pill-text" x={endPill.x + 16} y={endPill.y + 9} dy="0.34em">
                {endPill.text}
              </text>
            </g>
          )}
          {offScalePill && (
            <g className="chart__reference chart__reference--offscale" data-reference="offscale" pointerEvents="none">
              <rect className="chart__reference-pill" x={offScalePill.x} y={offScalePill.y} width={offScalePill.w} height={18} rx={9} />
              <text
                className="chart__reference-label"
                x={offScalePill.x + offScalePill.w - 7}
                y={offScalePill.y + 9}
                dy="0.34em"
                textAnchor="end"
              >
                {offScalePill.text}
              </text>
            </g>
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
          {/* Phone: the inset labels sit above the lines (with their card-colour halo),
              so a line passing through the plot never crosses the figures. */}
          {compact &&
            yTicks.map((v) => (
              <g key={`label-${v}`} className="chart__inset-labels">
              <text
                className={clsx("chart__axis-label", compact ? "chart__axis-label--inset" : "chart__axis-label--y")}
                x={compact ? PAD.left + 2 : PAD.left - 8}
                y={compact ? scales.y(v) - 4 : scales.y(v)}
                dy={compact ? undefined : "0.32em"}
              >
                {valueFormat(v, yStep)}
              </text>
              {showRightAxis && rightFmt && (
                <text
                  className={clsx(
                    "chart__axis-label",
                    compact ? "chart__axis-label--inset chart__axis-label--inset-end" : "chart__axis-label--right",
                    `chart__axis-label--${rightSeries?.toneCls ?? "estimate"}`,
                  )}
                  x={compact ? width - PAD.right - 2 : width - PAD.right + 8}
                  y={compact ? scales.y(v) - 4 : scales.y(v)}
                  dy={compact ? undefined : "0.32em"}
                >
                  {rightFmt(v * rightScale, yStep && yStep * rightScale)}
                </text>
              )}
              </g>
            ))}
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
            {tipExtra && <div className="chart__tooltip-extra">{tipExtra}</div>}
          </output>
        )}
      </div>
      {compact && cursorT !== null ? (
        <output className="chart__readout">
          <span className="chart__readout-time">{tipTime(cursorT)}</span>
          {tipRows.map((r) => (
            <span key={r.id} className="chart__readout-item">
              <span className={clsx("chart__swatch", `chart__swatch--${r.tone}`)} aria-hidden />
              <span className="chart__readout-label">{r.label}</span>
              <span className="chart__readout-value">{r.value}</span>
            </span>
          ))}
          {tipExtra && <span className="chart__readout-item chart__readout-extra">{tipExtra}</span>}
        </output>
      ) : all.length > 1 || legendExtra || band?.label ? (
        <ul className="chart__legend">
          {(all.length > 1 ? all : []).map((s) => {
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
          {band?.label && (
            <li className="chart__legend-item" data-legend-band>
              <span className="chart__swatch chart__swatch--band" aria-hidden />
              {band.label}
            </li>
          )}
          {legendExtra && <li className="chart__legend-extra">{legendExtra}</li>}
        </ul>
      ) : compact ? (
        // Same height as the readout, so scrubbing never moves the page.
        <div className="chart__readout chart__readout--idle" aria-hidden />
      ) : null}
    </div>
  );
}
