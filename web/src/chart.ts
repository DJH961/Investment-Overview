/**
 * A tiny dependency-free line-chart helper (inline SVG) shared by the Overview
 * "value over time" graph and the Risk equity curve. It draws one or more value
 * series onto a padded plot area with a y-axis (value gridlines) and an x-axis
 * (date ticks) so the curve reads as a chart, not abstract art.
 *
 * The SVG keeps its aspect ratio (`xMidYMid meet`) and scales to its container
 * width via CSS, so axis text never stretches. Everything is built with the DOM
 * API (no innerHTML) to keep the same XSS posture as the rest of the UI.
 */

import type { Decimal } from "./decimal-config";
import { formatCurrencyShort } from "./format";

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
 * The x-axis tick set for a date series. Short windows (≈a quarter or less) read
 * better as day-of-month labels — "1M" should say "5 Jun … 19 Jun", not repeat
 * the month — while wider windows keep the compact "Jun '26" month label. Up to
 * `count` roughly-even ticks are returned (more than the old start/middle/end)
 * so the axis is easier to read when it fits.
 */
export function xAxisTicks(dates: string[], count = 5): XAxisTick[] {
  const n = dates.length;
  if (n === 0) return [];
  const labelFor = spanDays(dates) <= 92 ? dayLabel : monthLabel;
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
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  if (min === max) {
    // Flat series: pad the range so the line sits in the middle.
    min -= 1;
    max += 1;
  }
  const span = max - min;

  const x = (i: number): number => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number): number => padT + plotH - ((v - min) / span) * plotH;

  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // --- Y axis: gridlines + value labels ----------------------------------
  const ticks = 4;
  for (let t = 0; t <= ticks; t += 1) {
    const value = min + (span * t) / ticks;
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
    label.textContent = formatCurrencyShort(seriesValueAt(series, value));
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
