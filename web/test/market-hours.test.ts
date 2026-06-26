import { describe, expect, it } from "vitest";

import {
  isUsMarketHoliday,
  isUsMarketOpen,
  isUsTradingDay,
  lastSessionDate,
  exchangeDate,
  latestSettledSessionDate,
  previousTradingSession,
  recentTradingSessions,
  sessionCloseMs,
  sessionOpenMs,
  nextSessionCloseMs,
  settledSessionsSince,
  elapsedSessionMs,
  sessionIsWarmingUp,
  isForexMarketOpen,
  forexMarketReopenMs,
  lastForexReopenMs,
  INTRADAY_BAR_INTERVAL_MS,
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

describe("isUsTradingDay", () => {
  it("is true at any time of day on a regular weekday — including after-hours", () => {
    // 2026-06-22 is a Monday: open, after the close, and overnight all read true.
    expect(isUsTradingDay(new Date("2026-06-22T14:00:00Z"))).toBe(true); // mid-session
    expect(isUsTradingDay(new Date("2026-06-22T21:00:00Z"))).toBe(true); // after close
    expect(isUsTradingDay(new Date("2026-06-22T12:00:00Z"))).toBe(true); // pre-market (08:00 ET)
  });

  it("is false on weekends and full-day holidays", () => {
    expect(isUsTradingDay(new Date("2026-06-20T14:00:00Z"))).toBe(false); // Saturday
    expect(isUsTradingDay(new Date("2026-06-21T14:00:00Z"))).toBe(false); // Sunday
    expect(isUsTradingDay(new Date("2026-01-01T15:00:00Z"))).toBe(false); // New Year's Day
    expect(isUsTradingDay(new Date("2026-07-03T15:00:00Z"))).toBe(false); // Independence (observed)
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

describe("exchangeDate", () => {
  it("is the New-York calendar date regardless of trading status", () => {
    // Sat 2026-06-27 14:00 UTC → still Saturday on the NY wall clock.
    expect(exchangeDate(new Date("2026-06-27T14:00:00Z"))).toBe("2026-06-27");
    // Mid-session Tuesday.
    expect(exchangeDate(new Date("2026-06-23T14:00:00Z"))).toBe("2026-06-23");
  });

  it("rolls back to the prior day late at night ET (UTC date is ahead)", () => {
    // 2026-06-24 02:00 UTC == 2026-06-23 22:00 ET → still the 23rd in New York.
    expect(exchangeDate(new Date("2026-06-24T02:00:00Z"))).toBe("2026-06-23");
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

describe("nextSessionCloseMs", () => {
  it("returns today's close when the session has not yet closed", () => {
    // 2026-06-23 (Tue) 10:00 ET == 14:00 UTC, before the 16:00 ET close.
    const now = new Date("2026-06-23T14:00:00.000Z");
    expect(new Date(nextSessionCloseMs(now)).toISOString()).toBe("2026-06-23T20:00:00.000Z");
  });

  it("rolls to the next trading day once today's close has passed", () => {
    // 2026-06-23 (Tue) 17:00 ET == 21:00 UTC, after the close → Wednesday's close.
    const now = new Date("2026-06-23T21:00:00.000Z");
    expect(new Date(nextSessionCloseMs(now)).toISOString()).toBe("2026-06-24T20:00:00.000Z");
  });

  it("skips the weekend from Friday evening to Monday's close", () => {
    // 2026-06-26 is a Friday; after its close the next close is Monday 2026-06-29.
    const now = new Date("2026-06-26T21:00:00.000Z");
    expect(new Date(nextSessionCloseMs(now)).toISOString()).toBe("2026-06-29T20:00:00.000Z");
  });

  it("returns today's close before the open on a trading day", () => {
    // 2026-06-23 (Tue) 07:00 ET == 11:00 UTC, pre-open → today's close.
    const now = new Date("2026-06-23T11:00:00.000Z");
    expect(new Date(nextSessionCloseMs(now)).toISOString()).toBe("2026-06-23T20:00:00.000Z");
  });
});

describe("settledSessionsSince (best-available blob age — Pillar 1 assumption 8)", () => {
  // As of 2026-06-23 14:00 UTC the latest *settled* session is 2026-06-22 (Monday;
  // Tuesday's close hasn't struck yet at 10:00 ET).
  const now = new Date("2026-06-23T14:00:00Z");

  it("is 0 when the blob is the latest settled session or newer", () => {
    expect(settledSessionsSince("2026-06-22T20:30:00Z", now)).toBe(0);
    expect(settledSessionsSince("2026-06-23T00:00:00Z", now)).toBe(0);
  });

  it("counts settled sessions strictly after the from-date", () => {
    // Fri 2026-06-19 is Juneteenth (holiday): 18 → 22 is one settled session.
    expect(settledSessionsSince("2026-06-18T20:30:00Z", now)).toBe(1);
    // Thu 2026-06-17 → {18, 22} = two settled sessions.
    expect(settledSessionsSince("2026-06-17T20:30:00Z", now)).toBe(2);
  });

  it("accepts a bare YYYY-MM-DD and uses only the date part", () => {
    expect(settledSessionsSince("2026-06-18", now)).toBe(1);
  });

  it("saturates at the cap for an ancient or unparseable date (never spins)", () => {
    expect(settledSessionsSince("1990-01-01", now, 10)).toBe(10);
    expect(settledSessionsSince("bad", now, 10)).toBe(10);
  });
});


describe("recentTradingSessions", () => {
  it("returns the N most recent sessions ascending, ending on the current one", () => {
    // Sat 2026-03-14 → the window ends on Friday 2026-03-13 and walks back a
    // holiday-free week.
    expect(recentTradingSessions(5, new Date("2026-03-14T16:00:00Z"))).toEqual([
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
    ]);
  });

  it("skips weekends and holidays when walking back", () => {
    // Mon 2026-06-22: walking back skips the weekend and Fri 2026-06-19
    // (Juneteenth) to reach Thursday 2026-06-18.
    expect(recentTradingSessions(2, new Date("2026-06-22T14:00:00Z"))).toEqual([
      "2026-06-18",
      "2026-06-22",
    ]);
  });

  it("returns an empty list for a non-positive count", () => {
    expect(recentTradingSessions(0, new Date("2026-03-14T16:00:00Z"))).toEqual([]);
    expect(recentTradingSessions(-3, new Date("2026-03-14T16:00:00Z"))).toEqual([]);
  });
});

describe("elapsedSessionMs / sessionIsWarmingUp (market_open_token_burn WS1)", () => {
  // Mon 2026-06-22 is a regular trading day. Open is 09:30 ET == 13:30 UTC (EDT).
  it("reports near-zero elapsed trading time at the open", () => {
    // 13:31 UTC == 09:31 ET, one minute after the open.
    const now = new Date("2026-06-22T13:31:00Z");
    expect(elapsedSessionMs(now)).toBe(60 * 1000);
  });

  it("treats a just-opened session as warming up (expected-empty, not stale)", () => {
    // 13:35 UTC == 09:35 ET, well under one intraday bar interval.
    expect(sessionIsWarmingUp(new Date("2026-06-22T13:35:00Z"))).toBe(true);
  });

  it("stops warming up once a full intraday bar interval has elapsed", () => {
    // 14:31 UTC == 10:31 ET, > 1h after the 09:30 open.
    expect(sessionIsWarmingUp(new Date("2026-06-22T14:31:00Z"))).toBe(false);
    expect(elapsedSessionMs(new Date("2026-06-22T14:31:00Z"))).toBeGreaterThan(
      INTRADAY_BAR_INTERVAL_MS,
    );
  });

  it("never treats a past/closed session as warming up", () => {
    // After Monday's close (20:30 UTC == 16:30 ET): the last session is fully
    // elapsed, so a missing bar there is genuinely stale, not expected-empty.
    expect(sessionIsWarmingUp(new Date("2026-06-22T20:30:00Z"))).toBe(false);
    // Before Tuesday's open (12:00 UTC == 08:00 ET): lastSessionDate is Monday,
    // whose elapsed time is over a day — never warming up.
    expect(sessionIsWarmingUp(new Date("2026-06-23T12:00:00Z"))).toBe(false);
  });

  it("treats a weekend as a fully-elapsed prior session", () => {
    // Sat 2026-06-27 — lastSessionDate is Friday, long since closed.
    expect(sessionIsWarmingUp(new Date("2026-06-27T15:00:00Z"))).toBe(false);
  });
});

describe("isForexMarketOpen (spot-FX weekend close)", () => {
  it("is open across a normal weekday (EDT)", () => {
    // Wed 2026-06-24 14:00 UTC == 10:00 ET.
    expect(isForexMarketOpen(new Date("2026-06-24T14:00:00Z"))).toBe(true);
    // Overnight on a weekday is still open (forex trades ~24×5).
    expect(isForexMarketOpen(new Date("2026-06-24T03:00:00Z"))).toBe(true);
  });

  it("stays open on Friday until 17:00 ET, then closes", () => {
    // Fri 2026-06-26 20:30 UTC == 16:30 ET — still open.
    expect(isForexMarketOpen(new Date("2026-06-26T20:30:00Z"))).toBe(true);
    // Fri 2026-06-26 21:00 UTC == 17:00 ET — closed.
    expect(isForexMarketOpen(new Date("2026-06-26T21:00:00Z"))).toBe(false);
    expect(isForexMarketOpen(new Date("2026-06-26T23:00:00Z"))).toBe(false);
  });

  it("is closed all day Saturday", () => {
    expect(isForexMarketOpen(new Date("2026-06-27T02:00:00Z"))).toBe(false);
    expect(isForexMarketOpen(new Date("2026-06-27T15:00:00Z"))).toBe(false);
    expect(isForexMarketOpen(new Date("2026-06-27T23:59:00Z"))).toBe(false);
  });

  it("reopens Sunday at 17:00 ET", () => {
    // Sun 2026-06-28 20:00 UTC == 16:00 ET — still closed.
    expect(isForexMarketOpen(new Date("2026-06-28T20:00:00Z"))).toBe(false);
    // Sun 2026-06-28 21:00 UTC == 17:00 ET — open again.
    expect(isForexMarketOpen(new Date("2026-06-28T21:00:00Z"))).toBe(true);
    expect(isForexMarketOpen(new Date("2026-06-28T23:00:00Z"))).toBe(true);
  });
});

describe("forexMarketReopenMs", () => {
  it("resolves the upcoming Sunday 17:00 ET from a Friday-evening close (EDT)", () => {
    const now = new Date("2026-06-26T22:00:00Z"); // Fri 18:00 ET, closed
    expect(new Date(forexMarketReopenMs(now)).toISOString()).toBe("2026-06-28T21:00:00.000Z");
  });

  it("resolves the upcoming Sunday from a Saturday", () => {
    const now = new Date("2026-06-27T12:00:00Z");
    expect(new Date(forexMarketReopenMs(now)).toISOString()).toBe("2026-06-28T21:00:00.000Z");
  });

  it("resolves today's reopen on a Sunday morning before 17:00 ET", () => {
    const now = new Date("2026-06-28T13:00:00Z"); // Sun 09:00 ET
    expect(new Date(forexMarketReopenMs(now)).toISOString()).toBe("2026-06-28T21:00:00.000Z");
  });

  it("honours EST (winter): Sunday 17:00 ET is 22:00 UTC", () => {
    const now = new Date("2026-01-10T12:00:00Z"); // Sat in January (EST)
    expect(new Date(forexMarketReopenMs(now)).toISOString()).toBe("2026-01-11T22:00:00.000Z");
  });
});

describe("lastForexReopenMs", () => {
  it("resolves the most recent Sunday 17:00 ET from a Sunday evening (EDT)", () => {
    const now = new Date("2026-06-28T22:00:00Z"); // Sun 18:00 ET, just reopened
    expect(new Date(lastForexReopenMs(now)).toISOString()).toBe("2026-06-28T21:00:00.000Z");
  });

  it("resolves the prior Sunday from a Monday pre-open", () => {
    const now = new Date("2026-06-29T12:00:00Z"); // Mon 08:00 ET
    expect(new Date(lastForexReopenMs(now)).toISOString()).toBe("2026-06-28T21:00:00.000Z");
  });

  it("resolves the prior Sunday from mid-week", () => {
    const now = new Date("2026-07-01T14:00:00Z"); // Wed 10:00 ET
    expect(new Date(lastForexReopenMs(now)).toISOString()).toBe("2026-06-28T21:00:00.000Z");
  });

  it("honours EST (winter): Sunday 17:00 ET is 22:00 UTC", () => {
    const now = new Date("2026-01-14T12:00:00Z"); // Wed in January (EST)
    expect(new Date(lastForexReopenMs(now)).toISOString()).toBe("2026-01-11T22:00:00.000Z");
  });
});
