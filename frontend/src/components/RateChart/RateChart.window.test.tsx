import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RateHistoryDto } from "../../lib/queries/currencyRate";
import { formatDate } from "../../lib/format";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));
const charts = vi.hoisted(() => ({ seen: [] as { series: { id: string; tone?: string; points: { t: string | number; v: number | null }[] }[] }[] }));
vi.mock("../Chart", () => ({
  Chart: (p: (typeof charts.seen)[number]) => {
    charts.seen.push(p);
    return <div data-testid="chart" />;
  },
}));

let history: RateHistoryDto;
vi.mock("../../lib/queries/currencyRate", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/currencyRate")>()),
  useRateHistory: () => ({ data: history, isPending: false, isFetching: false, isError: false }),
}));

const { RateChart } = await import("./RateChart");

const point = (t: string, rate: string) => ({ t, rate, inverse: String(1 / Number(rate)) });
const pts = [point("2022-12-30", "1.07"), point("2023-02-28", "1.06"), point("2023-03-01", "1.065"), point("2023-06-01", "1.09")];
const win = (key: string, ctx: string | null) => ({ key, start: "1999-01-04", through: "2023-06-01", live: false, intraday: false, context_until: ctx });
const hist = (range: string, ctx: string | null): RateHistoryDto =>
  ({ range, granularity: "daily", source: "ECB", points: pts, window: win(range, ctx) }) as unknown as RateHistoryDto;

describe("RateChart window and context", () => {
  it("prints the range window the server resolved", () => {
    history = hist("all", null);
    render(<RateChart currency="USD" range="all" />);
    expect(screen.getByTestId("rate-window")).toHaveTextContent(`All · ${formatDate("1999-01-04")} – ${formatDate("2023-06-01")}`);
  });

  it("Max: the part before you started is a separate dashed context series", () => {
    charts.seen = [];
    history = hist("max", "2023-02-28");
    render(<RateChart currency="USD" range="max" />);
    const series = charts.seen.at(-1)!.series;
    const before = series.find((s) => s.id === "rate-before")!;
    const own = series.find((s) => s.id === "rate")!;
    expect(before.tone).toBe("invested");
    expect(own.tone).toBe("primary");
    // Nothing from before you started in your line, but the two meet at one point.
    expect(before.points.map((p) => p.t)).toEqual(["2022-12-30", "2023-02-28"]);
    expect(own.points.map((p) => p.t)).toEqual(["2023-02-28", "2023-03-01", "2023-06-01"]);
  });

  it("All: one solid line, nothing before the first transaction", () => {
    charts.seen = [];
    history = hist("all", null);
    render(<RateChart currency="USD" range="all" />);
    expect(charts.seen.at(-1)!.series.map((s) => s.id)).toEqual(["rate"]);
  });
});
