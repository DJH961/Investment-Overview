import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chart, segments, timeTicks, type ChartSeries } from "./Chart";

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

  it("places intraday ticks on round clock times", () => {
    const h = 3_600_000;
    const open = Date.UTC(2026, 10, 2, 14, 30);
    const ticks = timeTicks(open, open + 6.5 * h, 7);
    expect(ticks[0]).toBe(Date.UTC(2026, 10, 2, 15, 0));
    expect(ticks.every((t) => t % h === 0)).toBe(true);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("uses time ticks, the tooltip time format and range labels", () => {
    const h = 3_600_000;
    const pts = [0, 1, 2, 3].map((i) => ({ t: Date.UTC(2026, 10, 2, 14, 30) + i * h, v: 100 + i }));
    render(
      <Chart
        {...props}
        series={[{ id: "a", label: "EUR", points: pts }]}
        xMode="time"
        tooltipTimeFormat={(t) => `TIP${t}`}
        ranges={["1d"]}
        range="1d"
        rangeLabel={(r) => r.toUpperCase()}
        onRangeChange={() => undefined}
        headerExtra={<span>+1.2%</span>}
      />,
    );
    expect(screen.getByText("1D")).toBeInTheDocument();
    expect(screen.getByText("+1.2%")).toBeInTheDocument();
    fireEvent.pointerMove(screen.getByRole("img"), { clientX: 0 });
    expect(screen.getByRole("status")).toHaveTextContent(`TIP${pts[0].t}`);
  });

  it("colours by trend and draws the end marker", () => {
    const { container } = render(<Chart {...props} series={[series[0]]} trend="down" />);
    expect(container.firstElementChild).toHaveClass("chart--down");
    expect(container.querySelector('[data-end-marker="down"]')).not.toBeNull();
  });

  it("marks a busy chart but keeps the curve", () => {
    const { container } = render(<Chart {...props} series={[series[0]]} busy />);
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".chart__line").length).toBeGreaterThan(0);
  });

  describe("secondary currency on a right axis", () => {
    const eur: ChartSeries = {
      id: "primary",
      label: "EUR",
      points: [
        { t: 1000, v: 100 },
        { t: 2000, v: 110 },
      ],
    };
    const usd: ChartSeries = {
      id: "secondary",
      label: "USD",
      axis: "right",
      scale: 1.1,
      valueFormat: (v) => `U${v.toFixed(1)}`,
      points: [
        { t: 1000, v: 110 },
        { t: 2000, v: 115.5 },
      ],
    };
    const firstY = (container: HTMLElement, id: string) =>
      /M[\d.]+,([\d.]+)/.exec(container.querySelector(`[data-series="${id}"] .chart__line`)?.getAttribute("d") ?? "")?.[1];

    it("starts both lines at the same pixel and labels the right axis as left x scale", () => {
      const { container } = render(
        <Chart {...props} series={[eur, usd]} rightAxisFormat={(v) => `R${Math.round(v)}`} />,
      );
      expect(firstY(container, "primary")).toBeDefined();
      expect(Number(firstY(container, "secondary"))).toBeCloseTo(Number(firstY(container, "primary")), 6);
      const left = [...container.querySelectorAll(".chart__axis-label--y")].map((n) => Number(n.textContent?.slice(1)));
      const right = [...container.querySelectorAll(".chart__axis-label--right")].map((n) =>
        Number(n.textContent?.slice(1)),
      );
      expect(right).toHaveLength(left.length);
      right.forEach((r, i) => expect(Math.abs(r - left[i] * 1.1)).toBeLessThanOrEqual(1));
    });

    it("shows the true secondary value in the tooltip", () => {
      render(<Chart {...props} series={[eur, usd]} rightAxisFormat={(v) => `R${v}`} />);
      fireEvent.pointerMove(screen.getByRole("img"), { clientX: 0 });
      expect(screen.getByRole("status")).toHaveTextContent("U110.0");
      expect(screen.getByRole("status")).toHaveTextContent("V100");
    });

    it("hides a series but keeps a legend toggle for it", () => {
      let toggled = "";
      const { container } = render(
        <Chart
          {...props}
          series={[eur, { ...usd, hidden: true }]}
          rightAxisFormat={(v) => `R${v}`}
          onToggleSeries={(id) => (toggled = id)}
        />,
      );
      expect(container.querySelector('[data-series="secondary"]')).toBeNull();
      expect(container.querySelector(".chart__axis-label--right")).toBeNull();
      const btn = screen.getByRole("button", { name: "USD" });
      expect(btn).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(btn);
      expect(toggled).toBe("secondary");
    });
  });
});
