import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chart, segments, type ChartSeries } from "./Chart";

const series: ChartSeries[] = [
  {
    id: "a",
    label: "Portfolio",
    tone: "primary",
    points: [
      { t: 1000, v: 100 },
      { t: 2000, v: 110 },
      { t: 3000, v: null },
      { t: 4000, v: 120 },
      { t: 5000, v: 130 },
    ],
  },
  {
    id: "b",
    label: "Bench",
    tone: "benchmark",
    points: [
      { t: 1000, v: 100 },
      { t: 5000, v: 105 },
    ],
  },
];

const props = {
  valueFormat: (v: number) => `V${Math.round(v)}`,
  timeFormat: (t: number) => `T${t}`,
};

describe("Chart", () => {
  it("renders a line per run, breaking at gaps", () => {
    const { container } = render(<Chart series={series} {...props} />);
    expect(container.querySelectorAll('[data-series="a"] .chart__line')).toHaveLength(2);
    expect(container.querySelectorAll('[data-series="b"] .chart__line')).toHaveLength(1);
    expect(container.querySelectorAll(".chart__area").length).toBeGreaterThan(0);
  });

  it("shows a tooltip on pointer move and hides it on Escape", () => {
    render(<Chart series={series} {...props} />);
    const svg = screen.getByRole("img");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.pointerMove(svg, { clientX: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("T1000");
    expect(screen.getByRole("status")).toHaveTextContent("V100");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("T2000");
    fireEvent.keyDown(svg, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the empty message", () => {
    render(<Chart series={[]} {...props} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    render(<Chart series={series} {...props} loading />);
    expect(screen.getByRole("status", { name: "Loading chart" })).toBeInTheDocument();
  });

  it("calls onRangeChange from the header", () => {
    let got = "";
    render(<Chart series={series} {...props} ranges={["1D", "1W"]} range="1D" onRangeChange={(r) => (got = r)} />);
    fireEvent.click(screen.getByText("1W"));
    expect(got).toBe("1W");
  });

  it("segments splits on null", () => {
    expect(
      segments([
        { x: 0, y: 1 },
        { x: 1, y: null },
        { x: 2, y: 3 },
      ]),
    ).toHaveLength(2);
  });

  it("draws a labelled reference line and keeps it inside the y range", () => {
    const { container } = render(
      <Chart {...props} series={[series[0]]} referenceLine={{ value: 500, label: "Cost basis" }} />,
    );
    expect(container.querySelector("[data-reference]")).not.toBeNull();
    expect(screen.getByText("Cost basis")).toBeInTheDocument();
    // 500 is far above the series (<=130), so the top y tick must reach it.
    const ticks = [...container.querySelectorAll(".chart__axis-label--y")].map((n) =>
      Number(n.textContent?.slice(1)),
    );
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(500);
  });

  it("draws no reference line by default", () => {
    const { container } = render(<Chart {...props} series={[series[0]]} />);
    expect(container.querySelector("[data-reference]")).toBeNull();
  });
});
