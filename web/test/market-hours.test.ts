import { describe, expect, it } from "vitest";

import { isUsMarketHoliday, isUsMarketOpen } from "../src/market-hours";

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
