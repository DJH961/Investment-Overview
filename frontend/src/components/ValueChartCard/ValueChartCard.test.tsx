import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
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
vi.mock("../../lib/queries/instruments", () => ({
  useInstruments: () => ({
    data: [
      { symbol: "FXAIX", intraday_twin: "VOO" },
      { symbol: "FSKAX", intraday_twin: "VTI" },
    ],
  }),
}));

import { ToastProvider } from "../Toast";
import { HideAmountsProvider } from "../../lib/hideAmounts";
import { handleLiveEvent } from "../../lib/live";
import { initialRange, ValueChartCard } from "./ValueChartCard";

const render = (ui: ReactElement) => rtlRender(<ToastProvider>{ui}</ToastProvider>);

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(initialRange({ serverDefault: "3m", marketOpen: false, remembered: null, configured: "6m" })).toBe("6m");
    expect(initialRange({ serverDefault: "1d", marketOpen: true, remembered: null, configured: "6m" })).toBe("1d");
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
    // The day label shares the growth line, so ranges never shift the layout.
    expect(screen.getByTestId("range-growth")).toHaveTextContent("1D · Fri 30/10");
    expect(screen.getByTestId("range-growth")).toHaveTextContent("-1.50%");
    expect(screen.getByText(/complete for 3 of 5 sessions/)).toBeInTheDocument();
    // axis ticks are clock times
    const xs = [...container.querySelectorAll(".chart__axis-label--x")].map((n) => n.textContent);
    expect(xs.every((x) => /^\d\d:\d\d$/.test(x ?? ""))).toBe(true);
  });

  it("1D: one short line however many funds are estimated, without naming them", () => {
    graphData = { ...day, funds_estimated: true, estimated_funds: ["FXAIX", "FSKAX"] };
    render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    expect(screen.getByTestId("funds-estimated-note")).toHaveTextContent(/^NAVs estimated$/);
  });

  it("the fund -> ETF twin mapping is in the tooltip", async () => {
    graphData = { ...day, funds_estimated: true, estimated_funds: ["FXAIX", "FSKAX"] };
    render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    fireEvent.focus(screen.getByRole("button", { name: "About estimated NAVs" }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("FXAIX → VOO");
    expect(tip).toHaveTextContent("FSKAX → VTI");
    expect(tip).not.toHaveTextContent("latest session only");
  });

  it("1W: same short line; the tooltip says only the latest session is estimated", async () => {
    graphData = { ...day, funds_estimated: true, estimated_funds: ["FXAIX"] };
    render(<ValueChartCard currency="EUR" defaultRange="1w" marketOpen />);
    expect(screen.getByTestId("funds-estimated-note")).toHaveTextContent(/^NAVs estimated$/);
    fireEvent.focus(screen.getByRole("button", { name: "About estimated NAVs" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("latest session only");
  });

  it("1M: no estimate note on the daily ranges", () => {
    graphData = { ...day, funds_estimated: true, estimated_funds: ["FXAIX"] };
    render(<ValueChartCard currency="EUR" defaultRange="1m" marketOpen />);
    expect(screen.queryByTestId("funds-estimated-note")).toBeNull();
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
    const width = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 900, height: 300 } as DOMRect);
    const { container, unmount } = render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    expect(container.querySelector('[data-series="secondary"]')).not.toBeNull();
    // Charts use the narrow symbol: "$116.7k", never "US$116.7k".
    expect(container.querySelector(".chart__axis-label--right")?.textContent).toMatch(/^\$/);
    width.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "USD" }));
    expect(container.querySelector('[data-series="secondary"]')).toBeNull();
    expect(localStorage.getItem("iv.chart.overview.secondary")).toBe("false");
    unmount();
    const again = render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    expect(again.container.querySelector('[data-series="secondary"]')).toBeNull();
  });

  describe("after the close: now_point", () => {
    const closed: Partial<GraphDto> = {
      ...day,
      growth: { pct: "0.0035", mode: "reference" },
      now_point: { t: "2026-11-02T22:00:00Z", v: "1010", overnight_currency: "-4.5", overnight_pct: "-0.0045" },
    };
    const ls = { move_pct: "0.008", overnight_currency: "-4.5", overnight_pct: "-0.0045" } as never;

    it("draws one 'Now' dot and the session/overnight split beside the ranges", () => {
      graphData = closed;
      const { container } = render(<ValueChartCard currency="EUR" defaultRange="1d" lastSession={ls} />);
      expect(container.querySelectorAll("[data-now-marker] circle")).toHaveLength(1);
      const label = container.querySelector("[data-now-marker]")?.textContent ?? "";
      expect(label).toBe("Now €1,010"); // the overnight figure lives in the split, not twice
      expect(screen.getByTestId("range-growth")).toHaveTextContent("+0.35%");
      expect(screen.getByTestId("range-split")).toHaveTextContent(/Session\s*\+0\.80%\s*Overnight\s*-0\.45%/);
      expect(screen.getByTestId("range-split")).not.toHaveTextContent("next day");
    });

    it("draws the same marker on 1W", () => {
      graphData = closed;
      const { container } = render(<ValueChartCard currency="EUR" defaultRange="1w" lastSession={ls} />);
      expect(container.querySelector("[data-now-marker]")).not.toBeNull();
    });

    it("has no marker or split when the currency did not move overnight (e.g. USD)", () => {
      graphData = { ...closed, now_point: { ...closed.now_point!, overnight_currency: "0", overnight_pct: "0" } };
      const { container } = render(
        <ValueChartCard currency="EUR" defaultRange="1d" lastSession={{ ...(ls as object), overnight_pct: "0" } as never} />,
      );
      expect(container.querySelector("[data-now-marker]")).toBeNull();
      expect(screen.queryByTestId("range-split")).toBeNull();
    });

    it("shows the split on 1D only (1W's figure is the week)", () => {
      graphData = closed;
      render(<ValueChartCard currency="EUR" defaultRange="1w" lastSession={ls} />);
      expect(screen.queryByTestId("range-split")).toBeNull();
    });

    it("with no now_point (market open) there is no dot, but the split still shows on 1D: last night's overnight", () => {
      graphData = { ...day, now_point: null };
      const { container } = render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen lastSession={ls} />);
      expect(container.querySelector("[data-now-marker]")).toBeNull();
      expect(screen.getByTestId("range-split")).toHaveTextContent(/Session\s*\+0\.80%\s*Overnight\s*-0\.45%/);
    });

    it("hide mode labels the dot with the range percent and shows no money", () => {
      localStorage.setItem("iv.privacy.hideAmounts", "true");
      graphData = closed;
      const { container } = render(
        <HideAmountsProvider>
          <ValueChartCard currency="EUR" defaultRange="1d" lastSession={ls} />
        </HideAmountsProvider>,
      );
      expect(container.querySelectorAll("[data-now-marker] circle")).toHaveLength(1);
      const label = container.querySelector("[data-now-marker]")?.textContent ?? "";
      expect(label).toBe("Now +0.35%");
      const split = screen.getByTestId("range-split");
      expect(split).toHaveTextContent("Session");
      expect(split).toHaveTextContent("-0.45%");
      expect(split).not.toHaveTextContent("€");
    });
  });

  it("reloads the shown graph and reports when the graphs event arrives", async () => {
    graphData = day;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ range: "1d", status: "started" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ValueChartCard currency="EUR" defaultRange="1d" marketOpen />);
    const btn = screen.getByRole("button", { name: "Reload 1D graph" });
    await act(async () => fireEvent.click(btn));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/graphs/1d/reload");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect(btn).toBeDisabled();
    act(() => handleLiveEvent(new QueryClient(), JSON.stringify({ type: "graphs", range: "1w", ok: true, points: 3 })));
    expect(btn).toBeDisabled();
    act(() => handleLiveEvent(new QueryClient(), JSON.stringify({ type: "graphs", range: "1d", ok: true, points: 42 })));
    expect(btn).toBeEnabled();
    expect(await screen.findByText("1D graph reloaded")).toBeInTheDocument();
    expect(screen.getByText("42 points")).toBeInTheDocument();
  });
});
