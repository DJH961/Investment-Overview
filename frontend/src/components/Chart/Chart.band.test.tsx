import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chart, bandPolygons } from "./Chart";

describe("bandPolygons", () => {
  it("one polygon per side, cut where the lines cross", () => {
    // a above b (smaller y), then below: one crossing at x = 15.
    const polys = bandPolygons([
      { x: 0, a: 10, b: 20 },
      { x: 10, a: 10, b: 20 },
      { x: 20, a: 30, b: 20 },
    ]);
    expect(polys.map((p) => p.side)).toEqual(["up", "down"]);
    expect(polys[0].d).toContain("L15,20");
    expect(polys[1].d.startsWith("M15,20")).toBe(true);
  });

  it("a missing value breaks the band; equal lines draw nothing", () => {
    expect(bandPolygons([{ x: 0, a: 5, b: 5 }, { x: 1, a: 5, b: 5 }])).toEqual([]);
    const polys = bandPolygons([
      { x: 0, a: 1, b: 2 },
      { x: 1, a: 1, b: 2 },
      { x: 2, a: null, b: 2 },
      { x: 3, a: 1, b: 2 },
      { x: 4, a: 1, b: 2 },
    ]);
    expect(polys).toHaveLength(2);
  });
});

describe("Chart band and conversion markers", () => {
  const t = (d: number) => `2026-01-${String(d).padStart(2, "0")}`;
  const series = [
    { id: "actual", label: "Actual", points: [1, 2, 3, 4].map((d) => ({ t: t(d), v: 100 + d * 2 })) },
    { id: "frozen", label: "At a frozen rate", tone: "ink" as const, points: [1, 2, 3, 4].map((d) => ({ t: t(d), v: 104 })) },
  ];

  it("draws a hatched band between two series with a legend entry", () => {
    const { container, getByText } = render(
      <Chart
        series={series}
        band={{ upper: "actual", lower: "frozen", label: "Currency effect" }}
        valueFormat={String}
        timeFormat={String}
      />,
    );
    const sides = [...container.querySelectorAll("[data-band-side]")].map((p) => p.getAttribute("data-band-side"));
    expect(sides).toEqual(["down", "up"]);
    expect(container.querySelectorAll("pattern")).toHaveLength(2);
    expect(getByText("Currency effect")).toBeInTheDocument();
    // The hatch is the fill: no gradient area under the primary line.
    expect(container.querySelector(".chart__area")).toBeNull();
  });

  it("draws neutral rings and above / below triangles, each with its label", () => {
    const { container } = render(
      <Chart
        series={series.slice(0, 1)}
        markers={[
          { t: t(2), v: 104, shape: "conversion", r: 6, label: "Converted €1,000" },
          { t: t(3), v: 106, shape: "above", label: "Above" },
          { t: t(4), v: 108, shape: "below", label: "Below" },
        ]}
        valueFormat={String}
        timeFormat={String}
      />,
    );
    const marks = [...container.querySelectorAll("[data-mark]")];
    expect(marks.map((m) => m.getAttribute("data-mark"))).toEqual(["conversion", "above", "below"]);
    expect(marks[0].querySelector("circle")?.getAttribute("r")).toBe("6");
    expect(marks[1].querySelector("title")?.textContent).toBe("Above");
  });
});
