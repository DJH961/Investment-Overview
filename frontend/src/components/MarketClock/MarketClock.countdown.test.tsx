import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketClock, firstFullHour, type ClockFreshness } from "./MarketClock";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Each timer re-arms from an effect, so step the clock one act() at a time. */
function advance(ms: number, step = 1000) {
  for (let t = 0; t < ms; t += step) {
    act(() => {
      vi.advanceTimersByTime(step);
    });
  }
}

const open: ClockFreshness = {
  market_state: "open",
  next_close_at: "2026-06-30T20:00:00+00:00",
  next_open_at: "2026-07-01T13:30:00+00:00",
  session_opened_at: "2026-06-30T13:30:00+00:00",
};
const closed: ClockFreshness = { market_state: "closed", next_close_at: null, next_open_at: "2026-07-01T13:30:00+00:00" };
const digits = () => screen.getByTestId("market-clock-digits").textContent;
const root = () => screen.getByTestId("market-clock");

describe("MarketClock countdown", () => {
  it("the statement: label, HH:MM:SS, bell time and one still sentence for screen readers", () => {
    render(<MarketClock freshness={open} now={new Date("2026-06-30T18:13:49Z")} />);
    expect(root()).toHaveTextContent("Until the closing bell");
    expect(digits()).toBe("01:46:11");
    expect(root()).toHaveTextContent("13:30 20:00");
    expect(root().querySelectorAll(".market-clock__tick")).toHaveLength(6);
    expect(root().querySelector(".market-clock__now")).toBeNull();
    expect(root().querySelector(".market-clock__visual")).toHaveAttribute("aria-hidden", "true");
    const sr = root().querySelector(".market-clock__sr");
    expect(sr).toHaveAttribute("aria-live", "off");
    expect(sr).toHaveTextContent("Market open. Closes at 20:00, in 1 hour 47 minutes.");
  });

  it("closed over a weekend: counts to the opening bell with days", () => {
    render(<MarketClock freshness={closed} now={new Date("2026-06-28T18:55:49Z")} />);
    expect(root()).toHaveTextContent("See you Wed 13:30");
    expect(digits()).toBe("2d18:34:11");
    expect(root()).toHaveTextContent("Last close Wed 13:30");
    expect(root().querySelectorAll(".market-clock__tick")).toHaveLength(0);
  });

  it("ticks every second, in step with the bell", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T18:13:49.400Z"));
    render(<MarketClock freshness={open} />);
    expect(digits()).toBe("01:46:11");
    advance(1000);
    expect(digits()).toBe("01:46:10");
    advance(3000);
    expect(digits()).toBe("01:46:07");
  });

  it("rolls over the minute, the hour and the day boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T13:28:58.000Z"));
    render(<MarketClock freshness={{ market_state: "closed", next_open_at: "2026-07-01T13:30:00Z" }} />);
    expect(digits()).toBe("1d00:01:02");
    advance(2000);
    expect(digits()).toBe("1d00:01:00");
    advance(61_000);
    expect(digits()).toBe("23:59:59");
  });

  it("across a DST change the countdown is the real elapsed time", () => {
    // Friday before the US spring-forward (2026-03-08) to the Monday open (13:30Z, EDT).
    const f: ClockFreshness = { market_state: "closed", next_open_at: "2026-03-09T13:30:00Z" };
    render(<MarketClock freshness={f} now={new Date("2026-03-06T21:00:00Z")} />);
    expect(digits()).toBe("2d16:30:00");
  });

  it("emphasises the last hour, breathes in the last minute, stays still with reduced motion", () => {
    const { rerender } = render(<MarketClock freshness={open} now={new Date("2026-06-30T18:00:00Z")} />);
    expect(root()).not.toHaveClass("market-clock--soon");
    rerender(<MarketClock freshness={open} now={new Date("2026-06-30T19:30:00Z")} />);
    expect(root()).toHaveClass("market-clock--soon");
    expect(root()).not.toHaveClass("market-clock--last");
    rerender(<MarketClock freshness={open} now={new Date("2026-06-30T19:59:30Z")} />);
    expect(root()).toHaveClass("market-clock--last");
  });

  it("reduced motion: no breathing", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    render(<MarketClock freshness={open} now={new Date("2026-06-30T19:59:30Z")} />);
    expect(root()).toHaveClass("market-clock--soon");
    expect(root()).not.toHaveClass("market-clock--last");
  });

  it("asks for fresh instants once at zero and never shows a negative", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T19:59:57.500Z"));
    const onBoundary = vi.fn();
    render(<MarketClock freshness={open} onBoundary={onBoundary} />);
    expect(digits()).toBe("00:00:03");
    advance(2000);
    expect(digits()).toBe("00:00:01");
    expect(onBoundary).not.toHaveBeenCalled();
    advance(1000);
    // A word, never a zero countdown.
    expect(screen.queryByTestId("market-clock-digits")).toBeNull();
    expect(screen.getByTestId("market-clock-word")).toHaveTextContent(/Settling|Closed/);
    expect(root()).toHaveTextContent("The closing bell has rung");
    expect(onBoundary).toHaveBeenCalledTimes(1);
    // No loop while the same (stale) instant stays on screen; later only the state.
    advance(10 * 60_000, 30_000);
    expect(onBoundary).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("market-clock-digits")).toBeNull();
    expect(root().textContent).not.toMatch(/-\d/);
  });

  it("a payload whose instants are already past (fixtures, stale cache) never refetches nor goes negative", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T09:00:00Z"));
    const onBoundary = vi.fn();
    render(<MarketClock freshness={open} onBoundary={onBoundary} />);
    advance(60 * 60_000, 60_000);
    expect(onBoundary).not.toHaveBeenCalled();
    expect(root()).toHaveTextContent("Open");
    expect(root().textContent).not.toMatch(/-/);
  });
});

describe("firstFullHour (progress bar notches)", () => {
  it("lands on the full hours of the wall clock, not the open + n hours", () => {
    // 15:30 in Berlin (CET) -> the first notch is 16:00 Berlin = 15:00Z.
    expect(new Date(firstFullHour(Date.parse("2026-11-17T14:30:00Z"), "Europe/Berlin")).toISOString()).toBe("2026-11-17T15:00:00.000Z");
    // A half-hour zone: 14:30Z is 20:00 in Kolkata, already a full hour there.
    expect(new Date(firstFullHour(Date.parse("2026-11-17T14:30:00Z"), "Asia/Kolkata")).toISOString()).toBe("2026-11-17T14:30:00.000Z");
  });
});

describe("MarketClock on a half day (Black Friday 2026: closes 13:00 ET = 18:00Z)", () => {
  const halfDay: ClockFreshness = {
    market_state: "open",
    next_close_at: "2026-11-27T18:00:00+00:00",
    next_open_at: "2026-11-30T14:30:00+00:00",
    session_opened_at: "2026-11-27T14:30:00+00:00",
  };
  it("counts to the early close, not to 16:00", () => {
    render(<MarketClock freshness={halfDay} now={new Date("2026-11-27T17:30:00Z")} />);
    expect(digits()).toBe("00:30:00");
    expect(root()).toHaveTextContent("14:30 18:00");
    // Full UTC hours inside 14:30-18:00: 15, 16, 17.
    expect(root().querySelectorAll(".market-clock__tick")).toHaveLength(3);
  });
  it("after the early close, the overnight bar starts at the real close", () => {
    const after: ClockFreshness = {
      market_state: "closed",
      next_close_at: "2026-11-30T21:00:00+00:00",
      next_open_at: "2026-11-30T14:30:00+00:00",
      last_close_at: "2026-11-27T18:00:00+00:00",
    };
    render(<MarketClock freshness={after} now={new Date("2026-11-27T19:00:00Z")} />);
    expect(root()).toHaveTextContent("See you Mon 14:30");
    // One hour into the 68.5 h wait from the real 18:00Z close (not a 17.5 h guess).
    expect(root().querySelector<HTMLElement>(".market-clock__fill")?.style.width).toBe("1.46%");
  });
});
