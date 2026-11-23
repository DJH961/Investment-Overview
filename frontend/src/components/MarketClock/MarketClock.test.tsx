import { describe, expect, it, vi } from "vitest";
import { clockView, formatCountdown, splitCountdown, trackProgress, type ClockFreshness } from "./MarketClock";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));



const open: ClockFreshness = {
  market_state: "open",
  next_close_at: "2026-06-30T20:00:00+00:00",
  next_open_at: "2026-07-01T13:30:00+00:00",
  session_opened_at: "2026-06-30T13:30:00+00:00",
};
const closed: ClockFreshness = { market_state: "closed", next_close_at: null, next_open_at: "2026-07-01T13:30:00+00:00" };

describe("formatCountdown", () => {
  it("hours and minutes, rounded up so it never says 0 early", () => {
    expect(formatCountdown(3 * 3_600_000 + 12 * 60_000)).toBe("3 h 12 min");
    expect(formatCountdown(2 * 3_600_000)).toBe("2 h");
    expect(formatCountdown(11 * 60_000 + 1)).toBe("12 min");
    expect(formatCountdown(45_000)).toBe("45 s");
    expect(formatCountdown(10)).toBe("1 s");
  });
});

describe("clockView", () => {
  it("counts to the server instant, whatever the display zone (US close 22:00 CET)", () => {
    const f: ClockFreshness = { market_state: "open", next_close_at: "2026-11-18T21:00:00Z", next_open_at: null };
    const now = new Date("2026-11-18T18:14:00Z");
    for (const tz of ["UTC", "Europe/Berlin", "America/New_York"]) {
      expect(clockView(f, now, tz).next).toBe("closes in 2 h 46 min");
    }
  });

  it("across a DST change the countdown is still the real elapsed time", () => {
    // US spring-forward 2026-03-08: close 16:00 EDT = 20:00Z, now 09:30 EST... = 14:30Z the same day.
    const f: ClockFreshness = { market_state: "open", next_close_at: "2026-03-08T20:00:00Z", next_open_at: null };
    expect(clockView(f, new Date("2026-03-08T14:30:00Z"), "America/New_York").next).toBe("closes in 5 h 30 min");
  });

  it("open: since the open, counting to the close", () => {
    const v = clockView(open, new Date("2026-06-30T16:48:00Z"), "UTC");
    expect(v.state).toBe("Open");
    expect(v.since).toMatch(/since 13:30/);
    expect(v.next).toBe("closes in 3 h 12 min");
  });

  it("closed: counting to the next open; more than a day away gives the weekday and time", () => {
    expect(clockView(closed, new Date("2026-07-01T11:16:00Z"), "UTC").next).toBe("opens in 2 h 14 min");
    const far = clockView(closed, new Date("2026-06-29T20:00:00Z"), "UTC").next ?? "";
    expect(far).toMatch(/^opens Wed 13:30$/);
  });

  it("holiday is named, never shown by color alone", () => {
    expect(clockView({ ...closed, market_state: "holiday" }, new Date("2026-07-01T11:00:00Z"), "UTC").state).toBe("Holiday");
  });

  it("a target in the past never shows a negative time", () => {
    const justPast = clockView(open, new Date("2026-06-30T20:01:00Z"), "UTC");
    expect(justPast.next).toBe("closing now");
    expect(justPast.remaining).toBeNull();
    const stale = clockView(open, new Date("2026-07-03T09:00:00Z"), "UTC");
    expect(stale.next).toBeNull();
    expect(stale.state).toBe("Open");
  });

  it("no instant from the server: only the state", () => {
    expect(clockView({ market_state: "closed" }, new Date(), "UTC")).toMatchObject({ state: "Closed", next: null });
  });
});


describe("splitCountdown", () => {
  it("HH:MM:SS, rounded up, days beyond 24 h, never negative", () => {
    expect(splitCountdown(6_371_000)).toEqual({ days: 0, clock: "01:46:11" });
    expect(splitCountdown(10)).toEqual({ days: 0, clock: "00:00:01" });
    expect(splitCountdown(86_400_000)).toEqual({ days: 1, clock: "00:00:00" });
    expect(splitCountdown(86_399_000)).toEqual({ days: 0, clock: "23:59:59" });
    expect(splitCountdown(2 * 86_400_000 + 19 * 3_600_000 + 4 * 60_000 + 11_000)).toEqual({ days: 2, clock: "19:04:11" });
    expect(splitCountdown(-5000)).toEqual({ days: 0, clock: "00:00:00" });
  });
});

describe("trackProgress", () => {
  it("open: elapsed share of the session", () => {
    expect(trackProgress(open, new Date("2026-06-30T16:45:00Z"))).toBeCloseTo(0.5, 5);
  });
  it("closed overnight: share of the 17.5 h wait; a Monday open waits out the weekend", () => {
    expect(trackProgress(closed, new Date("2026-06-30T20:00:00Z"))).toBeCloseTo(0, 5);
    expect(trackProgress(closed, new Date("2026-07-01T13:30:00Z"))).toBeCloseTo(1, 5);
    const mon: ClockFreshness = { market_state: "closed", next_open_at: "2026-06-29T13:30:00Z" };
    expect(trackProgress(mon, new Date("2026-06-27T12:00:00Z"))).toBeGreaterThan(0.2);
    expect(trackProgress(mon, new Date("2026-06-26T20:00:00Z"))).toBeCloseTo(0, 5);
  });
  it("a stale instant clamps to the ends", () => {
    expect(trackProgress(open, new Date("2026-07-09T00:00:00Z"))).toBe(1);
  });
});
