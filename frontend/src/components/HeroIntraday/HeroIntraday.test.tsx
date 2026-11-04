import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphDto } from "../../lib/queries/portfolio";

const graph = vi.hoisted(() => ({ data: undefined as Partial<GraphDto> | undefined }));

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useGraph: () => ({ data: graph.data, isPending: !graph.data }),
}));
vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

import { HeroIntraday, intradayShape } from "./HeroIntraday";

const day: Partial<GraphDto> = {
  range: "1d",
  ccy: "EUR",
  session_date: "2026-10-30",
  market_open: false,
  direction: "down",
  reference: "1000",
  sessions: [{ date: "2026-10-30", open: "2026-10-30T13:30:00Z", close: "2026-10-30T20:00:00Z" }],
  points: [
    { t: "2026-10-30T13:30:00Z", v: "990" },
    { t: "2026-10-30T16:00:00Z", v: "1010" },
    { t: "2026-10-30T20:00:00Z", v: "980" },
  ],
};
// Monday before the US open: the curve shown is Friday's.
const NOW = new Date("2026-11-02T09:00:00Z");

describe("intradayShape", () => {
  it("spans the session and keeps the previous close on the chart", () => {
    const s = intradayShape(day as GraphDto)!;
    expect(s.low).toBe(980);
    expect(s.high).toBe(1010);
    expect(s.start).toBe(Date.parse("2026-10-30T13:30:00Z"));
    expect(s.stop).toBe(Date.parse("2026-10-30T20:00:00Z"));
    expect(s.refY).not.toBeNull();
    expect(s.refY!).toBeGreaterThan(0);
    expect(s.refY!).toBeLessThan(100);
    expect(s.end).toEqual({ left: 100, top: expect.any(Number) as number });
  });

  it("a live day fills in from the left (x runs to the session close)", () => {
    const live = { ...day, points: day.points!.slice(0, 2) } as GraphDto;
    expect(intradayShape(live)!.end!.left).toBeCloseTo((2.5 / 6.5) * 100, 5);
  });

  it("needs two points", () => {
    expect(intradayShape({ ...day, points: day.points!.slice(0, 1) } as GraphDto)).toBeNull();
  });
});

describe("HeroIntraday", () => {
  it("labels the last session and shows low, high and the previous close", () => {
    graph.data = day;
    const { container } = render(<HeroIntraday currency="EUR" now={NOW} />);
    expect(screen.getByText("Last session · Fri")).toBeInTheDocument();
    expect(screen.getByText("€980.00")).toBeInTheDocument();
    expect(screen.getByText("€1,010.00")).toBeInTheDocument();
    expect(screen.getByText("€1,000.00")).toBeInTheDocument();
    expect(container.querySelector(".hero-intraday--down .hero-intraday__line")).not.toBeNull();
    expect(container.querySelector(".hero-intraday__ref")).not.toBeNull();
  });

  it("keeps its frame (same plot box) while the graph loads", () => {
    graph.data = undefined;
    const { container } = render(<HeroIntraday currency="EUR" now={NOW} />);
    expect(container.querySelector(".hero-intraday__plot")).not.toBeNull();
    expect(container.querySelectorAll(".hero-intraday__fact")).toHaveLength(3);
    expect(container.querySelector(".hero-intraday__line")).toBeNull();
  });
});
