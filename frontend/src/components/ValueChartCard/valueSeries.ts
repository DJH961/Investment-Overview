import type { ChartSeries } from "../Chart";
import { chartMoneyFormat, formatPercent } from "../../lib/format";
import { toNum, type GraphDto } from "../../lib/queries/portfolio";

export const pctFormat = (v: number) => formatPercent(v, { signed: true, digits: 1 });

/** First non-zero value of a series, or the 1D previous close when known. */
export function hideBase(pts: { v?: string | null }[], ref: number | null): number | null {
  const first = pts.map((p) => toNum(p.v)).find((v) => v !== null && v !== 0) ?? null;
  return ref !== null && ref !== 0 ? ref : first;
}

/** "% from range start" label for a raw value (hide mode labels only; geometry untouched). */
export const relFormat = (base: number | null) => (v: number) =>
  base === null ? "•••" : pctFormat(v / base - 1);

export interface ValueSeriesFormats {
  primary: (v: number) => string;
  secondary: (v: number) => string;
}

/**
 * The plotted series: identical points and scale in normal and hide mode, so the
 * curve shape, y-range, trend colour and baseline never change. Hide mode only
 * swaps the label formatters (axis, tooltip) for "% from range start".
 */
export function buildValueSeries(
  g: GraphDto,
  opts: { hide: boolean; showSecondary: boolean },
): { series: ChartSeries[]; formats: ValueSeriesFormats } {
  const { hide, showSecondary } = opts;
  const ref = g.range === "1d" ? toNum(g.reference) : null;
  const sec = g.secondary;
  const primaryFmt = hide ? relFormat(hideBase(g.points, ref)) : chartMoneyFormat(g.ccy, "tooltip");
  const secondaryFmt =
    hide && sec ? relFormat(hideBase(sec.points, null)) : chartMoneyFormat(sec?.ccy ?? g.ccy, "tooltip");
  const series: ChartSeries[] = [
    { id: "primary", label: g.ccy, points: g.points.map((p) => ({ t: p.t, v: toNum(p.v) })), valueFormat: primaryFmt },
  ];
  const scale = toNum(sec?.scale);
  if (sec && scale !== null && scale > 0 && sec.points.length) {
    series.push({
      id: "secondary",
      label: sec.ccy,
      points: sec.points.map((p) => ({ t: p.t, v: toNum(p.v) })),
      scale,
      axis: "right",
      valueFormat: secondaryFmt,
      hidden: !showSecondary,
    });
  }
  return { series, formats: { primary: primaryFmt, secondary: secondaryFmt } };
}
