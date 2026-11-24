import { QueryClient } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRefreshEvent, getRefreshState, resetRefreshState } from "../../lib/refresh";
import { HeroMarketCorner } from "../OverviewHero/OverviewHero";
import { MarketClock, type ClockFreshness } from "./MarketClock";
import { CLOSING_MAX, marketPhase } from "./marketPhase";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

/**
 * The bell moments end to end on the client: the clock boundary, the server's
 * `market_session` events and the refetched payload, in the order they land. US
 * Eastern is UTC-5 in late November: 16:00 ET = 21:00Z, 09:30 ET = 14:30Z, the Black
 * Friday half day closes 13:00 ET = 18:00Z.
 */
const qc = new QueryClient();
const bell = (state: string, at: string) =>
  act(() => {
    applyRefreshEvent(qc, { type: "market_session", state, prices_live: state === "open", at, market_state: "open", ts: 1 });
  });
const tick = (live: boolean) =>
  act(() => {
    applyRefreshEvent(qc, { type: "tick", prices_live: live, last_update_at: new Date().toISOString() });
  });
function advance(ms: number, step = 1000) {
  for (let t = 0; t < ms; t += step) act(() => void vi.advanceTimersByTime(step));
}

function Harness({ f, live }: { f: ClockFreshness; live: boolean }) {
  return (
    <>
      <HeroMarketCorner freshness={f} live={live} />
      <MarketClock freshness={f} />
    </>
  );
}
const corner = () => screen.queryByTestId("hero-market-corner")?.textContent ?? null;
const clock = () => screen.getByTestId("market-clock");
const noErrors = () => expect(document.body.textContent).not.toMatch(/error|couldn't|failed/i);

beforeEach(() => {
  vi.useFakeTimers();
  resetRefreshState();
});
afterEach(() => {
  resetRefreshState();
  vi.useRealTimers();
});

describe("the closing bell (Mon 23 Nov 2026, 15:59:50 to 16:05 ET)", () => {
  const open: ClockFreshness = {
    market_state: "open",
    next_close_at: "2026-11-23T21:00:00Z",
    next_open_at: "2026-11-24T14:30:00Z",
    session_opened_at: "2026-11-23T14:30:00Z",
  };
  const closed: ClockFreshness = {
    market_state: "closed",
    next_close_at: "2026-11-24T21:00:00Z",
    next_open_at: "2026-11-24T14:30:00Z",
    last_close_at: "2026-11-23T21:00:00Z",
  };

  it("Live, then Closing… from the bell until the closing prices are in, then Closed", () => {
    vi.setSystemTime(new Date("2026-11-23T20:59:50Z"));
    tick(true);
    const seen: (string | null)[] = [];
    const note = () => {
      if (seen[seen.length - 1] !== corner()) seen.push(corner());
    };
    const { rerender } = render(<Harness f={open} live />);
    note();
    expect(clock()).toHaveTextContent("Until the closing bell");
    expect(clock()).not.toHaveClass("market-clock--ring");

    // The bell on the client clock, before any word from the server.
    advance(10_000);
    note();
    expect(corner()).toBe("Closing…");
    expect(clock()).toHaveTextContent("The closing bell has rung");
    expect(clock()).toHaveTextContent("Bell! That's the close");
    expect(clock()).toHaveClass("market-clock--ring");
    expect(screen.getByTestId("market-clock-bell")).toHaveClass("market-clock__bell--rang");

    // The server's bell: the last tick's "live" is cleared.
    bell("closing", "2026-11-23T21:00:01Z");
    expect(getRefreshState().pricesLive).toBe(false);
    // The refetched payload already says closed (and its cached caption still says live):
    // the event wins, it stays "Closing…".
    advance(30_000);
    rerender(<Harness f={closed} live />);
    note();
    expect(corner()).toBe("Closing…");
    expect(clock()).toHaveAttribute("data-phase", "closing");

    // The closing prices are in (60 s grace).
    advance(35_000);
    bell("closed", "2026-11-23T21:01:05Z");
    note();
    expect(corner()).toBe("Closed");
    expect(clock()).toHaveAttribute("data-phase", "closed");

    // Past 16:05: the bell moment is over; the clock looks ahead to tomorrow.
    advance(5 * 60_000, 10_000);
    note();
    expect(clock()).toHaveTextContent("Opens in 17 h");
    expect(clock()).not.toHaveClass("market-clock--ring");
    expect(seen).toEqual(["Live", "Closing…", "Closed"]);
    noErrors();
  });

  it("without any server event the clock alone still says Closing…, never a stale Live", () => {
    vi.setSystemTime(new Date("2026-11-23T20:59:50Z"));
    render(<Harness f={open} live />);
    expect(corner()).toBe("Live");
    advance(15_000);
    expect(corner()).toBe("Closing…");
    // A lost follow-up never leaves it up for good.
    expect(marketPhase({ freshness: open, session: null, pricesLive: null, payloadLive: true, now: new Date(Date.parse("2026-11-23T21:00:00Z") + CLOSING_MAX + 1) })).toBe("live");
    noErrors();
  });
});

describe("the opening bell (Tue 24 Nov 2026, 09:29:50 to 09:31 ET)", () => {
  const closed: ClockFreshness = {
    market_state: "closed",
    next_close_at: "2026-11-24T21:00:00Z",
    next_open_at: "2026-11-24T14:30:00Z",
    last_close_at: "2026-11-23T21:00:00Z",
  };
  const open: ClockFreshness = {
    market_state: "open",
    next_close_at: "2026-11-24T21:00:00Z",
    next_open_at: "2026-11-25T14:30:00Z",
    session_opened_at: "2026-11-24T14:30:00Z",
  };

  it("muted Opening until the first tick, then Live with one pulse", () => {
    vi.setSystemTime(new Date("2026-11-24T14:29:50Z"));
    const { rerender } = render(<Harness f={closed} live={false} />);
    expect(corner()).toBeNull();
    expect(clock()).toHaveTextContent("Until the opening bell");

    advance(10_000);
    expect(corner()).toBe("Opening");
    expect(clock()).toHaveTextContent("The opening bell has rung");
    expect(clock()).toHaveTextContent("Bell! Market's open");
    expect(clock()).toHaveClass("market-clock--ring");

    bell("opening", "2026-11-24T14:30:00Z");
    // The refetched payload: open, no live prices yet.
    rerender(<Harness f={open} live={false} />);
    expect(corner()).toBe("Opening");
    expect(screen.getByTestId("hero-market-corner")).toHaveClass("overview-hero__corner--opening");

    advance(40_000);
    tick(true);
    expect(corner()).toBe("Live");
    expect(screen.getByTestId("hero-market-corner")).toHaveClass("overview-hero__corner--pulse");
    bell("open", "2026-11-24T14:30:41Z");
    expect(corner()).toBe("Live");
    // The pulse plays once.
    advance(2000);
    expect(screen.getByTestId("hero-market-corner")).not.toHaveClass("overview-hero__corner--pulse");
    advance(5 * 60_000, 10_000);
    expect(clock()).toHaveTextContent("Until the closing bell");
    noErrors();
  });
});

describe("the half-day close (Black Friday 27 Nov 2026, 13:00 ET)", () => {
  const open: ClockFreshness = {
    market_state: "open",
    next_close_at: "2026-11-27T18:00:00Z",
    next_open_at: "2026-11-30T14:30:00Z",
    session_opened_at: "2026-11-27T14:30:00Z",
  };
  const closed: ClockFreshness = {
    market_state: "closed",
    next_close_at: "2026-11-30T21:00:00Z",
    next_open_at: "2026-11-30T14:30:00Z",
    last_close_at: "2026-11-27T18:00:00Z",
  };
  it("rings at 13:00, then says See you Mon", () => {
    vi.setSystemTime(new Date("2026-11-27T17:59:50Z"));
    const { rerender } = render(<Harness f={open} live />);
    advance(10_000);
    expect(corner()).toBe("Closing…");
    expect(clock()).toHaveTextContent("Bell! That's the close");
    bell("closing", "2026-11-27T18:00:00Z");
    rerender(<Harness f={closed} live={false} />);
    advance(65_000);
    bell("closed", "2026-11-27T18:01:05Z");
    expect(corner()).toBe("Closed");
    advance(5 * 60_000, 10_000);
    expect(clock()).toHaveTextContent("See you Mon 14:30");
    noErrors();
  });
});
