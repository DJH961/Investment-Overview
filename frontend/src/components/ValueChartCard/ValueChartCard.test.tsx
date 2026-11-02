import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphDto, GraphRange } from "../../lib/queries/portfolio";

const calls: { range: GraphRange; ccy: string }[] = [];
const remembered: GraphRange[] = [];
let graphData: Partial<GraphDto> | undefined;

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useGraph: (range: GraphRange, ccy: string) => {
    calls.push({ range, ccy });
    return {
      data: graphData ? { range, ccy, sessions: [], points: [], ...graphData } : undefined,
      isPending: !graphData,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    };
  },
  rememberGraphRange: (r: GraphRange) => remembered.push(r),
}));
vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

import { initialRange, ValueChartCard } from "./ValueChartCard";

afterEach(() => {
  calls.length = 0;
  remembered.length = 0;
  graphData = undefined;
  localStorage.clear();
});

const day: Partial<GraphDto> = {
  points: [
    { t: "2026-11-02T14:30:00Z", v: "1000" },
    { t: "2026-11-02T15:30:00Z", v: "990" },
  ],
  reference: "1005",
  direction: "down",
  session_date: "2026-10-30",
  growth: { pct: "-0.015", mode: "reference" },
  coverage: { covered: 3, total: 5, complete: false },
};

describe("initialRange", () => {
  it("opens on the server default while the market is open, else the device's last choice", () => {
    expect(initialRange({ serverDefault: "1d", marketOpen: true, remembered: "1y" })).toBe("1d");
    expect(initialRange({ serverDefault: "1m", marketOpen: false, remembered: "1y" })).toBe("1y");
    expect(initialRange({ serverDefault: "3m", marketOpen: false, remembered: null })).toBe("3m");
    expect(initialRange({ marketOpen: false, remembered: null })).toBe("1m");
  });
});

describe("ValueChartCard", () => {
  it("uses the server default, uppercase labels, and remembers a change on device and server", () => {
    graphData = day;
    render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    expect(calls.at(-1)).toEqual({ range: "1d", ccy: "EUR" });
    expect(screen.getByText("ALL")).toBeInTheDocument();
    fireEvent.click(screen.getByText("1W"));
    expect(calls.at(-1)?.range).toBe("1w");
    expect(remembered).toEqual(["1w"]);
    expect(localStorage.getItem("iv.chart.overview.range")).toBe('"1w"');
  });

  it("1D: dashed previous close, trend colour, day subtitle, growth and coverage note", () => {
    graphData = day;
    const { container } = render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    expect(screen.getByText("Prev close €1,005")).toBeInTheDocument();
    expect(container.querySelector(".chart--down")).not.toBeNull();
    expect(screen.getByText("Fri 30 Oct")).toBeInTheDocument();
    expect(screen.getByTestId("range-growth")).toHaveTextContent("-1.50%");
    expect(screen.getByText(/complete for 3 of 5 sessions/)).toBeInTheDocument();
    // axis ticks are clock times
    const xs = [...container.querySelectorAll(".chart__axis-label--x")].map((n) => n.textContent);
    expect(xs.every((x) => /^\d\d:\d\d$/.test(x ?? ""))).toBe(true);
  });

  it("draws the other currency by default on a right axis and remembers the toggle", () => {
    graphData = {
      ...day,
      secondary: {
        ccy: "USD",
        scale: "1.08",
        points: [
          { t: "2026-11-02T14:30:00Z", v: "1080" },
          { t: "2026-11-02T15:30:00Z", v: "1075" },
        ],
      },
    };
    const { container, unmount } = render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    expect(container.querySelector('[data-series="secondary"]')).not.toBeNull();
    expect(container.querySelector(".chart__axis-label--right")?.textContent).toMatch(/US\$/);
    fireEvent.click(screen.getByRole("button", { name: "USD" }));
    expect(container.querySelector('[data-series="secondary"]')).toBeNull();
    expect(localStorage.getItem("iv.chart.overview.secondary")).toBe("false");
    unmount();
    const again = render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    expect(again.container.querySelector('[data-series="secondary"]')).toBeNull();
  });
});
