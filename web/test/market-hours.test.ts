import { describe, expect, it } from "vitest";

import {
  isUsMarketHoliday,
  isUsMarketOpen,
  lastSessionDate,
  latestSettledSessionDate,
  previousTradingSession,
  sessionCloseMs,
  sessionOpenMs,
} from "../src/market-hours";

/**
 * The instants below are expressed in UTC; the helper must convert them to the
 * New York wall clock itself. During US daylight saving (March–November) New
 * York is UTC-4, so 14:00 UTC == 10:00 ET (open) and 20:30 UTC == 16:30 ET
 * (closed).
 */
describe("isUsMarketOpen", () => {
  it("is open mid-session on a weekday", () => {
    // Mon 2026-06-22 14:00 UTC == 10:00 ET.
    expect(isUsMarketOpen(new Date("2026-06-22T14:00:00Z"))).toBe(true);
  });

  it("is closed before the 09:30 ET open", () => {
    // Mon 2026-06-22 13:00 UTC == 09:00 ET.
    expect(isUsMarketOpen(new Date("2026-06-22T13:00:00Z"))).toBe(false);
  });

  it("is closed after the 16:00 ET close", () => {
    // Mon 2026-06-22 20:30 UTC == 16:30 ET.
    expect(isUsMarketOpen(new Date("2026-06-22T20:30:00Z"))).toBe(false);
  });

  it("is closed at weekends even during session hours", () => {
    // Sat 2026-06-20 14:00 UTC == 10:00 ET.
    expect(isUsMarketOpen(new Date("2026-06-20T14:00:00Z"))).toBe(false);
    // Sun 2026-06-21 14:00 UTC == 10:00 ET.
    expect(isUsMarketOpen(new Date("2026-06-21T14:00:00Z"))).toBe(false);
  });

  it("is open exactly at the 09:30 ET bell and closed exactly at 16:00 ET", () => {
    // Mon 2026-06-22 13:30 UTC == 09:30 ET (open boundary, inclusive).
    expect(isUsMarketOpen(new Date("2026-06-22T13:30:00Z"))).toBe(true);
    // Mon 2026-06-22 20:00 UTC == 16:00 ET (close boundary, exclusive).
    expect(isUsMarketOpen(new Date("2026-06-22T20:00:00Z"))).toBe(false);
  });

  it("is closed during session hours on a full-day market holiday", () => {
    // Independence Day, observed Fri 2026-07-03 (Jul 4 is a Saturday in 2026).
    expect(isUsMarketOpen(new Date("2026-07-03T15:00:00Z"))).toBe(false);
    // Christmas Day, Fri 2025-12-25 14:30 UTC == 09:30 ET.
    expect(isUsMarketOpen(new Date("2025-12-25T15:00:00Z"))).toBe(false);
    // Thanksgiving, Thu 2025-11-27.
    expect(isUsMarketOpen(new Date("2025-11-27T16:00:00Z"))).toBe(false);
  });
});

describe("isUsMarketHoliday", () => {
  it("recognises fixed-date holidays with the observed-day rule", () => {
    // New Year's Day 2026 falls on a Thursday — closed.
    expect(isUsMarketHoliday(new Date("2026-01-01T15:00:00Z"))).toBe(true);
    // Independence Day 2026 is Saturday Jul 4 → observed Friday Jul 3.
    expect(isUsMarketHoliday(new Date("2026-07-03T15:00:00Z"))).toBe(true);
    expect(isUsMarketHoliday(new Date("2026-07-04T15:00:00Z"))).toBe(false); // actual Sat
    // Christmas Day 2025 (Thursday).
    expect(isUsMarketHoliday(new Date("2025-12-25T15:00:00Z"))).toBe(true);
  });

  it("recognises floating-date holidays", () => {
    // MLK Day 2026 — 3rd Monday of January = Jan 19.
    expect(isUsMarketHoliday(new Date("2026-01-19T15:00:00Z"))).toBe(true);
    // Memorial Day 2026 — last Monday of May = May 25.
    expect(isUsMarketHoliday(new Date("2026-05-25T15:00:00Z"))).toBe(true);
    // Thanksgiving 2025 — 4th Thursday of November = Nov 27.
    expect(isUsMarketHoliday(new Date("2025-11-27T15:00:00Z"))).toBe(true);
    // Good Friday 2026 — Apr 3 (Easter Sunday is Apr 5, 2026).
    expect(isUsMarketHoliday(new Date("2026-04-03T15:00:00Z"))).toBe(true);
    // Juneteenth 2026 — Jun 19 (Friday).
    expect(isUsMarketHoliday(new Date("2026-06-19T15:00:00Z"))).toBe(true);
  });

  it("treats an ordinary trading day as not a holiday", () => {
    expect(isUsMarketHoliday(new Date("2026-06-22T15:00:00Z"))).toBe(false);
  });
});

describe("latestSettledSessionDate", () => {
  it("returns today once its 16:00 ET close has passed", () => {
    // Tue 2026-06-23 20:30 UTC == 16:30 ET — today's session has settled.
    expect(latestSettledSessionDate(new Date("2026-06-23T20:30:00Z"))).toBe("2026-06-23");
  });

  it("returns the prior session before today's close (pre-open / mid-session)", () => {
    // Tue 2026-06-23 13:00 UTC == 09:00 ET (pre-open) → previous trading day Mon.
    expect(latestSettledSessionDate(new Date("2026-06-23T13:00:00Z"))).toBe("2026-06-22");
    // Tue 2026-06-23 14:00 UTC == 10:00 ET (mid-session, today not yet settled).
    expect(latestSettledSessionDate(new Date("2026-06-23T14:00:00Z"))).toBe("2026-06-22");
  });

  it("skips back over weekends", () => {
    // Sat 2026-06-27 12:00 UTC → most recent settled close is Friday 2026-06-26.
    expect(latestSettledSessionDate(new Date("2026-06-27T12:00:00Z"))).toBe("2026-06-26");
    // Sun 2026-06-28 12:00 UTC → still Friday 2026-06-26.
    expect(latestSettledSessionDate(new Date("2026-06-28T12:00:00Z"))).toBe("2026-06-26");
  });

  it("skips back over full-day market holidays", () => {
    // Independence Day observed Fri 2026-07-03; the morning of that holiday the
    // latest settled session is Thursday 2026-07-02.
    expect(latestSettledSessionDate(new Date("2026-07-03T15:00:00Z"))).toBe("2026-07-02");
    // The Monday after Juneteenth (Fri 2026-06-19) skips back over both the
    // weekend and the holiday to Thursday 2026-06-18.
    expect(latestSettledSessionDate(new Date("2026-06-22T13:00:00Z"))).toBe("2026-06-18");
  });
});

describe("lastSessionDate", () => {
  it("is today once the 09:30 ET open has passed on a trading day", () => {
    // Tue 2026-06-23 14:00 UTC == 10:00 ET (mid-session).
    expect(lastSessionDate(new Date("2026-06-23T14:00:00Z"))).toBe("2026-06-23");
  });

  it("stays today after the close, through the evening", () => {
    // Tue 2026-06-23 21:00 UTC == 17:00 ET (after close, same session).
    expect(lastSessionDate(new Date("2026-06-23T21:00:00Z"))).toBe("2026-06-23");
  });

  it("is the previous trading day before today's open", () => {
    // Tue 2026-06-23 13:00 UTC == 09:00 ET (pre-open) → Monday's session.
    expect(lastSessionDate(new Date("2026-06-23T13:00:00Z"))).toBe("2026-06-22");
  });

  it("shows Friday's session across the weekend", () => {
    // Sat 2026-06-27 14:00 UTC → Friday 2026-06-26.
    expect(lastSessionDate(new Date("2026-06-27T14:00:00Z"))).toBe("2026-06-26");
  });
});

describe("previousTradingSession", () => {
  it("steps back one weekday", () => {
    expect(previousTradingSession("2026-06-23")).toBe("2026-06-22");
  });

  it("skips a weekend", () => {
    // Mon 2026-06-29 → Fri 2026-06-26.
    expect(previousTradingSession("2026-06-29")).toBe("2026-06-26");
  });

  it("skips a full-day holiday and the weekend", () => {
    // Before Mon 2026-06-22 the previous session skips the weekend and Fri
    // 2026-06-19 (Juneteenth) to land on Thursday 2026-06-18.
    expect(previousTradingSession("2026-06-22")).toBe("2026-06-18");
  });
});

describe("sessionCloseMs / sessionOpenMs", () => {
  it("resolves 16:00 / 09:30 ET to UTC during daylight saving (UTC-4)", () => {
    // 2026-06-23 is EDT: 16:00 ET == 20:00 UTC, 09:30 ET == 13:30 UTC.
    expect(new Date(sessionCloseMs("2026-06-23")).toISOString()).toBe("2026-06-23T20:00:00.000Z");
    expect(new Date(sessionOpenMs("2026-06-23")).toISOString()).toBe("2026-06-23T13:30:00.000Z");
  });

  it("resolves 16:00 ET to UTC during standard time (UTC-5)", () => {
    // 2026-01-12 is EST: 16:00 ET == 21:00 UTC.
    expect(new Date(sessionCloseMs("2026-01-12")).toISOString()).toBe("2026-01-12T21:00:00.000Z");
  });
});
