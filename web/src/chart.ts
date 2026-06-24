/**
 * A tiny dependency-free line-chart helper (inline SVG) shared by the Overview
 * "value over time" graph and the Risk equity curve. It draws one or more value
 * series onto a padded plot area with a y-axis (value gridlines) and an x-axis
 * (date or, for the intraday "1D" curve, time-of-day ticks) so the curve reads
 * as a chart, not abstract art.
 *
 * The SVG keeps its aspect ratio (`xMidYMid meet`) and scales to its container
 * width via CSS, so axis text never stretches. Everything is built with the DOM
 * API (no innerHTML) to keep the same XSS posture as the rest of the UI.
 */

import type { Decimal } from "./decimal-config";
import { formatCurrencyShort } from "./format";
import { clockOptions } from "./time-format";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ChartSeries {
  /** Value at each point in EUR (null = gap); must align with `dates`. */
  values: Array<Decimal | null>;
  /** CSS class for the path stroke. */
  className: string;
  /** Whether to fill a soft area under the line (the primary series). */
  area?: boolean;
}

export interface LineChartOptions {
  /** ISO `YYYY-MM-DD` labels, one per index, shared by every series. */
  dates: string[];
  series: ChartSeries[];
  /**
   * Optional custom formatter for y-axis labels. Defaults to formatCurrencyShort.
   * `fractionDigits` is the number of decimals the axis needs for adjacent ticks
   * to read distinctly (derived from the "nice" step); currency formatters honour
   * it, while ratio formatters (e.g. drawdown percent) may ignore it.
   */
  yAxisLabel?: (value: number, fractionDigits?: number) => string;
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-19" → "Jun '26"; passes through anything unexpected. */
function monthLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTH_NAMES[Number(m[2]) - 1] ?? m[2];
  return `${month} '${m[1].slice(2)}`;
}

/** "2026-06-19" → "19 Jun"; passes through anything unexpected. */
function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTH_NAMES[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${month}`;
}

/** True when an ISO label carries a wall-clock time (e.g. an intraday instant). */
function hasClockTime(iso: string): boolean {
  return /T\d{2}:\d{2}/.test(iso);
}

/**
 * An ISO instant → a local clock label (e.g. "9:30", "4:00 PM"), honouring the
 * device's 12h/24h preference. Used for the intraday "1D" curve, where every
 * point falls on the same calendar day and a date axis would just repeat that
 * date — the time-of-day is the only thing that varies. Passes through anything
 * that can't be parsed as an instant.
 */
function timeLabel(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...clockOptions() });
}

/**
 * Span in whole days between the first and last label, or `Infinity` when a
 * date can't be parsed (so the caller falls back to month granularity).
 */
function spanDays(dates: string[]): number {
  const a = Date.parse(dates[0]);
  const b = Date.parse(dates[dates.length - 1]);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(b - a) / 86_400_000;
}

/**
 * Up to `count` roughly-even indexes spanning `[0, n-1]` (always including both
 * ends), de-duplicated. Lets the x-axis carry more ticks when space allows.
 */
function evenIndexes(n: number, count: number): number[] {
  if (n <= 1) return [0];
  const c = Math.max(2, Math.min(count, n));
  const idx: number[] = [];
  for (let t = 0; t < c; t += 1) idx.push(Math.round((t / (c - 1)) * (n - 1)));
  return uniqueIndexes(idx);
}

export interface XAxisTick {
  index: number;
  text: string;
  anchor: "start" | "middle" | "end";
}

/**
 * The x-axis tick set for a value series. An **intraday** window — every label
 * on the same calendar day, carrying a wall-clock time (the live "1D" curve) —
 * is labelled by time-of-day ("9:30 … 4:00 PM"), because a date axis would only
 * repeat that one date. Otherwise short windows (≈a quarter or less) read better
 * as day-of-month labels — "1M" should say "5 Jun … 19 Jun", not repeat the
 * month — while wider windows keep the compact "Jun '26" month label. Up to
 * `count` roughly-even ticks are returned (more than the old start/middle/end)
 * so the axis is easier to read when it fits.
 */
export function xAxisTicks(dates: string[], count = 5): XAxisTick[] {
  const n = dates.length;
  if (n === 0) return [];
  const span = spanDays(dates);
  const labelFor =
    span < 1 && hasClockTime(dates[0]) ? timeLabel : span <= 92 ? dayLabel : monthLabel;
  const idx = evenIndexes(n, count);
  const last = idx[idx.length - 1];
  return idx.map((i) => ({
    index: i,
    text: labelFor(dates[i]),
    anchor: i === 0 ? "start" : i === last ? "end" : "middle",
  }));
}

/**
 * Build the chart SVG. Returns `null` when there are fewer than two plottable
 * points (a single dot is not a curve). The viewBox is fixed; CSS scales it.
 */
export function buildLineChart(options: LineChartOptions): SVGSVGElement | null {
  const { dates, series } = options;
  const yAxisLabel =
    options.yAxisLabel ?? ((v: number, digits?: number) => formatCurrencyShort(seriesValueAt(series, v), digits));
  const n = dates.length;
  const primary = series[0]?.values ?? [];
  const plottable = primary.filter((v) => v !== null).length;
  if (n < 2 || plottable < 2) return null;

  const width = 600;
  const height = 220;
  const padL = 52;
  const padR = 14;
  const padT = 12;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // Shared value scale across every series so they are directly comparable.
  const allValues: number[] = [];
  for (const s of series) {
    for (const v of s.values) if (v !== null) allValues.push(v.toNumber());
  }
  // "Nice" rounded bounds + step so the y-axis gridlines land on tidy round
  // numbers (e.g. 30k, 32.5k, 35k) instead of arbitrary fractions of the raw
  // data range, while keeping the same compact label width.
  const axis = niceAxis(Math.min(...allValues), Math.max(...allValues));
  const min = axis.min;
  const max = axis.max;
  const span = max - min;

  const x = (i: number): number => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number): number => padT + plotH - ((v - min) / span) * plotH;

  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // --- Y axis: gridlines + value labels ----------------------------------
  // One gridline per "nice" tick value, so the labels read as round numbers and
  // there are a few more of them (more exact) without widening the axis. The
  // label precision is derived from the step so a narrow window (e.g. an intraday
  // curve hugging €47k) reads "47.0k / 47.2k …" instead of "47k" on every tick.
  const fractionDigits = axisFractionDigits(axis.ticks, axis.step, yAxisLabel);
  for (const value of axis.ticks) {
    const yy = y(value);
    const grid = svgEl("line");
    grid.setAttribute("x1", String(padL));
    grid.setAttribute("x2", String(width - padR));
    grid.setAttribute("y1", yy.toFixed(1));
    grid.setAttribute("y2", yy.toFixed(1));
    grid.setAttribute("class", "chart-grid");
    svg.appendChild(grid);

    const label = svgEl("text");
    label.setAttribute("x", String(padL - 6));
    label.setAttribute("y", (yy + 3).toFixed(1));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = yAxisLabel(value, fractionDigits);
    svg.appendChild(label);
  }

  // --- X axis: date ticks ------------------------------------------------
  for (const tick of xAxisTicks(dates)) {
    const label = svgEl("text");
    label.setAttribute("x", x(tick.index).toFixed(1));
    label.setAttribute("y", String(height - 8));
    label.setAttribute("text-anchor", tick.anchor);
    label.setAttribute("class", "chart-axis-label");
    label.textContent = tick.text;
    svg.appendChild(label);
  }

  // --- Series paths (drawn back-to-front so the primary sits on top) ------
  for (let s = series.length - 1; s >= 0; s -= 1) {
    const current = series[s];
    const d = linePath(current.values, x, y);
    if (d === "") continue;
    if (current.area) {
      const areaPath = svgEl("path");
      areaPath.setAttribute("d", `${d} L${x(n - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`);
      areaPath.setAttribute("class", `${current.className}-area`);
      svg.appendChild(areaPath);
    }
    const path = svgEl("path");
    path.setAttribute("d", d);
    path.setAttribute("class", current.className);
    path.setAttribute("fill", "none");
    svg.appendChild(path);
  }

  return svg;
}

/** A value Decimal for an axis tick, reusing the first series' Decimal type. */
function seriesValueAt(series: ChartSeries[], value: number): Decimal {
  const sample = series[0].values.find((v): v is Decimal => v !== null)!;
  // decimal.js Decimals are immutable; derive a same-typed instance.
  return sample.mul(0).plus(value);
}

function linePath(
  values: Array<Decimal | null>,
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  values.forEach((v, i) => {
    if (v === null) return;
    d += `${d === "" ? "M" : "L"}${x(i).toFixed(1)} ${y(v.toNumber()).toFixed(1)} `;
  });
  return d.trim();
}

function uniqueIndexes(idx: number[]): number[] {
  return [...new Set(idx)].filter((i) => i >= 0).sort((a, b) => a - b);
}

/**
 * The number of decimal places the y-axis labels need so adjacent ticks read
 * distinctly. Starts from the precision implied by the "nice" step at its k/M
 * display scale (e.g. a €200 step on a €47k axis ⇒ "0.2k" ⇒ 1 decimal), then —
 * because the formatter may round (or be a non-currency label) — bumps the
 * precision until no two consecutive tick labels collide, capped so the axis
 * never sprouts a long tail of digits.
 */
export function axisFractionDigits(
  ticks: number[],
  step: number,
  label: (value: number, fractionDigits?: number) => string,
): number {
  const MAX_DIGITS = 3;
  const maxAbs = Math.max(...ticks.map((t) => Math.abs(t)), 0);
  const scale = maxAbs >= 1_000_000 ? 1_000_000 : maxAbs >= 1_000 ? 1_000 : 1;
  const stepInScale = step / scale;
  let digits =
    !Number.isFinite(stepInScale) || stepInScale <= 0 || stepInScale >= 1
      ? 0
      : Math.min(MAX_DIGITS, Math.ceil(-Math.log10(stepInScale)));
  // Guard against rounding collisions (e.g. the formatter snapping 47.0k/47.2k
  // to the same string): raise precision until consecutive labels differ.
  for (; digits < MAX_DIGITS; digits += 1) {
    let collision = false;
    for (let i = 1; i < ticks.length; i += 1) {
      if (label(ticks[i], digits) === label(ticks[i - 1], digits)) {
        collision = true;
        break;
      }
    }
    if (!collision) break;
  }
  return digits;
}

/** A "nice" value axis: rounded bounds, a round step, and the tick values. */
export interface NiceAxis {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/**
 * Compute a "nice" value axis for `[dataMin, dataMax]`: rounded bounds and a
 * step drawn from the 1 / 2 / 5 × 10ⁿ family, so gridline labels land on tidy
 * round numbers (e.g. 30k, 32k, 34k) instead of arbitrary fractions of the raw
 * data range. Aims for about `targetTicks` intervals and keeps the tick set
 * small so the y-axis stays narrow. Degenerate/flat input returns a unit band
 * centred on the value so the line still sits mid-plot.
 */
export function niceAxis(dataMin: number, dataMax: number, targetTicks = 4): NiceAxis {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMin === dataMax) {
    const c = Number.isFinite(dataMin) ? dataMin : 0;
    return { min: c - 1, max: c + 1, step: 1, ticks: [c - 1, c, c + 1] };
  }
  const step = niceNum((dataMax - dataMin) / Math.max(1, targetTicks), true);
  const min = Math.floor(dataMin / step) * step;
  const max = Math.ceil(dataMax / step) * step;
  // Derive the count from the rounded bounds so floating-point drift across
  // many steps can't drop or duplicate the final tick.
  const count = Math.max(1, Math.round((max - min) / step));
  const ticks: number[] = [];
  for (let i = 0; i <= count; i += 1) ticks.push(min + i * step);
  return { min, max, step, ticks };
}

/**
 * Round `value` up to the nearest "nice" number (1 / 2 / 5 × 10ⁿ). With
 * `round` true it snaps to the *nearest* nice number rather than the ceiling,
 * which gives a tick step closest to the requested granularity.
 */
function niceNum(value: number, round: boolean): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const frac = value / 10 ** exp;
  let niceFrac: number;
  if (round) {
    if (frac < 1.5) niceFrac = 1;
    else if (frac < 3) niceFrac = 2;
    else if (frac < 7) niceFrac = 5;
    else niceFrac = 10;
  } else if (frac <= 1) {
    niceFrac = 1;
  } else if (frac <= 2) {
    niceFrac = 2;
  } else if (frac <= 5) {
    niceFrac = 5;
  } else {
    niceFrac = 10;
  }
  return niceFrac * 10 ** exp;
}
