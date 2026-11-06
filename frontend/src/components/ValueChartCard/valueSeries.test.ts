import { describe, expect, it } from "vitest";
import type { GraphDto } from "../../lib/queries/portfolio";
import { buildValueSeries, hideBase, relFormat } from "./valueSeries";

const graph = {
  range: "1d",
  ccy: "EUR",
  reference: "100",
  points: [
    { t: 1000, v: "100" },
    { t: 2000, v: "104" },
    { t: 3000, v: "98" },
    { t: 4000, v: "103" },
  ],
  secondary: {
    ccy: "USD",
    scale: "1.1",
    points: [
      { t: 1000, v: "110" },
      { t: 2000, v: "115" },
      { t: 3000, v: "108" },
      { t: 4000, v: "113" },
    ],
  },
} as unknown as GraphDto;

const geometry = (hide: boolean) =>
  buildValueSeries(graph, { hide, showSecondary: true }).series.map((s) => ({
    id: s.id,
    scale: s.scale,
    axis: s.axis,
    hidden: s.hidden,
    points: s.points,
  }));

describe("buildValueSeries hide mode", () => {
  it("plots identical points, scale and axes in both modes", () => {
    expect(geometry(true)).toEqual(geometry(false));
  });

  it("normalised y positions match between modes", () => {
    const norm = (hide: boolean) => {
      const vs = buildValueSeries(graph, { hide, showSecondary: true }).series[0].points.map((p) => p.v as number);
      const lo = Math.min(...vs);
      const hi = Math.max(...vs);
      return vs.map((v) => (v - lo) / (hi - lo));
    };
    expect(norm(true)).toEqual(norm(false));
  });

  it("masks labels as percent from the range base in hide mode only", () => {
    const hidden = buildValueSeries(graph, { hide: true, showSecondary: true });
    expect(hidden.formats.primary(104)).toBe(relFormat(100)(104));
    expect(hidden.formats.primary(104)).not.toMatch(/€|104/);
    const shown = buildValueSeries(graph, { hide: false, showSecondary: true });
    expect(shown.formats.primary(104)).toMatch(/104/);
  });

  it("uses the 1D previous close as base, else the first usable value", () => {
    expect(hideBase([{ v: "0" }, { v: "50" }], null)).toBe(50);
    expect(hideBase([{ v: "50" }], 80)).toBe(80);
  });
});
