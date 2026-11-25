import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { MarketChip } from "../MarketClock/MarketChip";
import { FxState } from "../FxState";
import { IDLE_REFRESH } from "../../lib/refresh";
import { marketPhase } from "../../lib/marketPhase";
import { describeFreshness, dayWords, holdingPriceTime } from ".";
import { clockLabel } from "../MarketClock/MarketClock";
import { moversBasisLabel } from "../MoversCard/MoversCard";
import { dayMoveLabel } from "../OverviewHero/OverviewHero";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

// Tuesday 24 Nov 2026: bells at 14:30Z / 21:00Z (winter).
const fresh = (over: Record<string, unknown>) => ({
  market_state: "closed" as const,
  prices_live: false,
  refresh_running: false,
  historical: false,
  progress_done: 0,
  progress_total: 0,
  last_close_at: "2026-11-23T21:00:00Z",
  next_open_at: "2026-11-24T14:30:00Z",
  next_close_at: "2026-11-24T21:00:00Z",
  session_opened_at: null,
  last_price_update_at: "2026-11-23T21:05:00Z",
  price_market_at: "2026-11-23T21:00:00Z",
  price_observed_at: "2026-11-23T21:05:00Z",
  ...over,
});
const openFresh = (over: Record<string, unknown> = {}) =>
  fresh({ market_state: "open", session_opened_at: "2026-11-24T14:30:00Z", prices_live: true, price_market_at: "2026-11-24T20:57:50Z", ...over });

const MOMENTS: { name: string; now: string; f: ReturnType<typeof fresh>; payloadLive: boolean; phase: string; chip: RegExp; day: string }[] = [
  { name: "10 min before the open", now: "2026-11-24T14:20:00Z", f: fresh({}), payloadLive: false, phase: "closed", chip: /^Closed/, day: "Last session" },
  { name: "the open, no data yet", now: "2026-11-24T14:30:30Z", f: fresh({}), payloadLive: false, phase: "opening", chip: /^Market open · first prices in a moment$/, day: "Last session" },
  { name: "open with prices", now: "2026-11-24T14:32:00Z", f: openFresh(), payloadLive: true, phase: "live", chip: /^Live/, day: "Today" },
  { name: "2 min before the close", now: "2026-11-24T20:58:00Z", f: openFresh(), payloadLive: true, phase: "live", chip: /^Live/, day: "Today" },
  { name: "closing", now: "2026-11-24T21:00:30Z", f: openFresh(), payloadLive: true, phase: "closing", chip: /^Closing · settling the closing prices$/, day: "Today" },
  {
    name: "closed",
    now: "2026-11-24T21:20:00Z",
    f: fresh({ last_close_at: "2026-11-24T21:00:00Z", next_open_at: "2026-11-25T14:30:00Z", price_market_at: "2026-11-24T21:00:00Z" }),
    payloadLive: false,
    phase: "closed",
    chip: /^Closed/,
    day: "Today",
  },
];

describe("the top bar chip, the phase and the day words at every open / close moment", () => {
  for (const m of MOMENTS) {
    it(m.name, () => {
      const now = new Date(m.now);
      // dayWords reads the wall clock ("Today" vs "Last session"), so pin it to the moment.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      onTestFinished(() => vi.useRealTimers());
      const phase = marketPhase({ freshness: m.f, session: null, pricesLive: null, payloadLive: m.payloadLive, now });
      expect(phase).toBe(m.phase);
      const view = describeFreshness(m.f as never, {
        live: "connected",
        refresh: IDLE_REFRESH,
        timeZone: "UTC",
        now,
        sessionDate: m.day === "Today" ? "2026-11-24" : "2026-11-23",
        phase,
      });
      expect(view.label).toMatch(m.chip);
      expect(dayWords(phase, m.day === "Today" ? "2026-11-24" : "2026-11-23", "UTC").label).toBe(m.day);
    });
  }

  it("the chip never says Live or Open while closing / opening, and the phone words are short", () => {
    const closing = describeFreshness(openFresh() as never, { live: "connected", refresh: IDLE_REFRESH, timeZone: "UTC", now: new Date("2026-11-24T21:00:30Z"), phase: "closing" });
    expect(closing.short).toBe("Closing…");
    expect(closing.status).not.toBe("live");
    const opening = describeFreshness(fresh({}) as never, { live: "connected", refresh: IDLE_REFRESH, timeZone: "UTC", now: new Date("2026-11-24T14:30:30Z"), phase: "opening" });
    expect(opening.short).toBe("Opening");
  });

  it("day words: closing settles, opening keeps last session's figures, live dot only while trading", () => {
    expect(dayWords("closing", "2026-11-24", "UTC")).toMatchObject({ label: "Today", live: false });
    expect(dayWords("closing", "2026-11-24", "UTC").caption).toMatch(/settled/);
    expect(dayWords("opening", "2026-11-23", "UTC")).toMatchObject({ label: "Last session", live: false });
    expect(dayWords("live", "2026-11-24", "UTC")).toMatchObject({ label: "Today", caption: null, live: true });
  });

  it("the overnight chip never shows in a live session, nor while opening or closing", () => {
    for (const m of MOMENTS) {
      const now = new Date(m.now);
      const phase = marketPhase({ freshness: m.f, session: null, pricesLive: null, payloadLive: m.payloadLive, now });
      const shut = phase === "closed";
      expect(dayWords(phase, "2026-11-24", "UTC").night, m.name).toBe(shut);
    }
  });

  it("once closed the clock reads like any shut market, not 'Bell! Closing time'", () => {
    const base = { open: false, remaining: 17 * 3_600_000, target: "2026-11-25T14:30:00Z", now: new Date("2026-11-24T21:04:00Z"), timeZone: "UTC" };
    expect(clockLabel({ ...base, bellRang: "close", phase: "closing" }).short).toBe("Bell! Closing time");
    expect(clockLabel({ ...base, bellRang: "close", phase: "closed" })).toEqual({ long: "Opens in 17 h", short: "Opens in 17 h" });
  });

  it("a holding's price stamp never says live while closing or closed", () => {
    const row = { market_open: true, price_as_of: "2026-11-24", price_market_at: "2026-11-24T20:59:50Z", asset_class: "etf", native_currency: "USD" } as never;
    expect(holdingPriceTime(row, true).marketOpen).toBe(true);
    expect(holdingPriceTime(row, dayWords("closing", "2026-11-24", "UTC").live).marketOpen).toBe(false);
    expect(holdingPriceTime(row, dayWords("closed", "2026-11-24", "UTC").live).marketOpen).toBe(false);
  });

  it("the overnight chip is for the weeknight between two sessions only; the movers card names the hero's day", () => {
    expect(dayWords("closed", "2026-11-24", "UTC", true).night).toBe(true); // Tue evening, next open Wed
    expect(dayWords("closed", "2026-11-27", "UTC", false).night).toBe(false); // Fri close, next open Mon
    expect(dayWords("holiday", "2026-11-26", "UTC", false).night).toBe(false);
    const o = { timeZone: "UTC", now: new Date("2026-11-29T22:20:00Z") };
    expect(moversBasisLabel("2026-11-27", o)).toBe(dayMoveLabel("2026-11-27", o));
  });

  it("the phone chip says when the market opens once it is shut, not just a countdown", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MarketChip freshness={fresh({ last_close_at: "2026-11-24T21:00:00Z", next_open_at: "2026-11-25T14:30:00Z" })} currency="EUR" now={new Date("2026-11-24T21:20:00Z")} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Closed · opens 14:30");
  });
});

describe("FxState on the home currency cards", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("moon over the weekend, sunrise for two hours after the reopen, nothing on a trading day", () => {
    vi.setSystemTime(new Date("2026-11-27T22:05:00Z"));
    const { unmount } = render(<FxState />);
    expect(screen.getByTestId("fx-state")).toHaveTextContent("FX closed for the weekend");
    unmount();
    vi.setSystemTime(new Date("2026-11-29T22:20:00Z"));
    const second = render(<FxState />);
    expect(screen.getByTestId("fx-state")).toHaveTextContent("FX is back");
    act(() => void vi.advanceTimersByTime(2 * 60 * 60_000 + 60_000));
    expect(screen.queryByTestId("fx-state")).toBeNull();
    second.unmount();
    vi.setSystemTime(new Date("2026-11-24T15:00:00Z"));
    render(<FxState />);
    expect(screen.queryByTestId("fx-state")).toBeNull();
  });
});
