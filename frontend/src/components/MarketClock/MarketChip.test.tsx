import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { MarketChip } from "./MarketChip";
import { MarketClock, formatChipSpan, type ClockFreshness } from "./MarketClock";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

const open: ClockFreshness = {
  market_state: "open",
  next_close_at: "2026-06-30T20:00:00Z",
  next_open_at: "2026-07-01T13:30:00Z",
  session_opened_at: "2026-06-30T13:30:00Z",
};

describe("formatChipSpan", () => {
  it("minutes resolution, never seconds", () => {
    expect(formatChipSpan(106 * 60_000)).toBe("1h 46m");
    expect(formatChipSpan(5 * 60_000 + 1)).toBe("6m");
    expect(formatChipSpan(20_000)).toBe("1m");
    expect(formatChipSpan(50 * 3_600_000)).toBe("2d 2h");
  });
});

describe("MarketChip", () => {
  it("shows state and minutes; a button with a full accessible name that opens the clock sheet", async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MarketChip freshness={open} currency="EUR" now={new Date("2026-06-30T18:13:49Z")} />
      </QueryClientProvider>,
    );
    const btn = screen.getByRole("button", { name: /Market open\. Closes at 20:00, in 1 hour 47 minutes\. Show the market clock/ });
    expect(btn).toHaveTextContent("Open for 1h 47m");
    await userEvent.click(btn);
    expect(await screen.findByTestId("market-clock-digits")).toHaveTextContent("01:46:11");
  });

  it("is the session's mini progress bar: filled to the elapsed share", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MarketChip freshness={open} currency="EUR" now={new Date("2026-06-30T16:45:00Z")} />
      </QueryClientProvider>,
    );
    // 13:30 -> 20:00 is 6.5 h; 16:45 is 3.25 h in.
    expect(screen.getByTestId("market-chip-fill")).toHaveStyle({ width: "50.0%" });
  });

  it("holidays and multi-day closures omit the fill bar and expose concise + word labels", () => {
    const qc = new QueryClient();
    const holiday: ClockFreshness = {
      market_state: "holiday",
      last_close_at: "2026-11-25T21:00:00Z",
      next_open_at: "2026-11-27T14:30:00Z",
      next_close_at: "2026-11-27T18:00:00Z",
    };
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MarketChip freshness={holiday} currency="EUR" now={new Date("2026-11-26T16:00:00Z")} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("market-chip-fill")).toBeNull();
    expect(container.querySelector(".market-chip__text")).toHaveTextContent("Holiday until Fri 14:30");
    expect(container.querySelector(".market-chip__short")).toHaveTextContent("Holiday until Fri");
    expect(container.querySelector(".market-chip__short")).not.toHaveTextContent("14:30");
    expect(container.querySelector(".market-chip__word")).toHaveTextContent("Holiday");
  });
});

describe("MarketClock near variant", () => {
  it("hidden until 15 minutes before the bell, then a compact band", () => {
    const { rerender } = render(<MarketClock freshness={open} now={new Date("2026-06-30T18:00:00Z")} variant="near" />);
    expect(screen.queryByTestId("market-clock")).toBeNull();
    rerender(<MarketClock freshness={open} now={new Date("2026-06-30T19:50:00Z")} variant="near" />);
    expect(screen.getByTestId("market-clock")).toHaveClass("market-clock--near");
    expect(screen.getByTestId("market-clock-digits")).toHaveTextContent("00:10:00");
  });
});
