import { describe, expect, it } from "vitest";

import { isUsMarketOpen } from "../src/market-hours";

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
});
