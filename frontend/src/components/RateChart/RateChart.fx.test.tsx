import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateHistoryDto } from "../../lib/queries/currencyRate";
import { forexReopen, fxMoment, isForexOpen } from "./fxWeekend";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "Europe/Berlin" }));

let history: RateHistoryDto;
vi.mock("../../lib/queries/currencyRate", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/currencyRate")>()),
  useRateHistory: () => ({ data: history, isPending: false, isFetching: false, isError: false }),
}));

const { RateChart } = await import("./RateChart");

const point = (t: string, rate: string) => ({ t, rate, inverse: String(1 / Number(rate)) });
const data = (pts: ReturnType<typeof point>[]): RateHistoryDto =>
  ({ range: "1d", granularity: "intraday", source: "live samples", points: pts }) as RateHistoryDto;

function advance(ms: number, step = 30_000) {
  for (let t = 0; t < ms; t += step) act(() => void vi.advanceTimersByTime(step));
}
const chip = () => screen.queryByTestId("rate-fx-state");
const card = () => document.querySelector(".rate-chart");

describe("the FX week (17:00 New York = 22:00Z in late November)", () => {
  it("closes Friday 17:00 and reopens Sunday 17:00 New York", () => {
    expect(isForexOpen(Date.parse("2026-11-27T21:59:59Z"))).toBe(true);
    expect(fxMoment(Date.parse("2026-11-27T22:00:00Z"))).toBe("weekend");
    expect(fxMoment(Date.parse("2026-11-28T12:00:00Z"))).toBe("weekend");
    expect(fxMoment(Date.parse("2026-11-29T21:59:59Z"))).toBe("weekend");
    expect(fxMoment(Date.parse("2026-11-29T22:00:00Z"))).toBe("back");
    expect(fxMoment(Date.parse("2026-11-30T00:00:00Z"))).toBe("open");
    expect(new Date(forexReopen(Date.parse("2026-11-28T12:00:00Z"))).toISOString()).toBe("2026-11-29T22:00:00.000Z");
    // Summer (EDT): 17:00 New York = 21:00Z.
    expect(fxMoment(Date.parse("2026-07-03T21:00:00Z"))).toBe("weekend");
    expect(fxMoment(Date.parse("2026-07-05T21:00:00Z"))).toBe("back");
  });
});

describe("RateChart FX weekend states", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Friday close: the moon chip and a calm end cap", () => {
    vi.setSystemTime(new Date("2026-11-27T21:59:50Z"));
    history = data([point("2026-11-27T21:00:00Z", "1.0500"), point("2026-11-27T21:55:00Z", "1.0510")]);
    render(<RateChart currency="USD" range="1d" />);
    expect(chip()).toBeNull();
    expect(card()).not.toHaveClass("rate-chart--fx-weekend");
    advance(30_000);
    expect(chip()).toHaveTextContent("FX market's off for the weekend");
    expect(chip()).toHaveAttribute("title", expect.stringContaining("Back Sun 23:00"));
    expect(card()).toHaveClass("rate-chart--fx-weekend");
  });

  it("Sunday reopen: the sunrise chip, and the first new tick grows in once", () => {
    vi.setSystemTime(new Date("2026-11-29T21:59:50Z"));
    history = data([point("2026-11-27T21:55:00Z", "1.0510")]);
    const { rerender } = render(<RateChart currency="USD" range="1d" />);
    expect(chip()).toHaveTextContent("FX market's off for the weekend");
    advance(30_000);
    expect(chip()).toHaveTextContent("FX is back");
    expect(card()).not.toHaveClass("rate-chart--fx-weekend");
    expect(card()).not.toHaveClass("rate-chart--fx-grow");
    history = data([point("2026-11-27T21:55:00Z", "1.0510"), point("2026-11-29T22:01:00Z", "1.0520")]);
    rerender(<RateChart currency="USD" range="1d" />);
    expect(card()).toHaveClass("rate-chart--fx-grow");
    advance(1000, 100);
    expect(card()).not.toHaveClass("rate-chart--fx-grow");
    // Two hours later it is just the rate again.
    advance(2 * 60 * 60_000, 60_000);
    expect(chip()).toBeNull();
  });
});
