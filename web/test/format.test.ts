/**
 * Tests for the per-holding "as of" freshness label. Locale-dependent strings
 * are asserted loosely (non-empty / contains a separator) to stay portable.
 */
import { describe, expect, it } from "vitest";

import { formatAsOf } from "../src/format";

describe("formatAsOf", () => {
  const now = new Date("2024-06-01T15:30:00Z");

  it("shows a clock time for a same-day live price", () => {
    const at = new Date("2024-06-01T09:05:00Z").getTime();
    const out = formatAsOf(at, "2024-05-01", now);
    // A time, not a date — contains a ':' and no month abbreviation digits.
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("shows a date for a live price observed before today", () => {
    const at = new Date("2024-05-20T09:05:00Z").getTime();
    const out = formatAsOf(at, "2024-05-01", now);
    expect(out).not.toMatch(/^\d{1,2}:\d{2}/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("falls back to the export date when there is no live timestamp", () => {
    const out = formatAsOf(null, "2024-05-20", now);
    // Rendered from the export's as_of date, so it is a date (no clock time).
    expect(out).not.toMatch(/:/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns the raw fallback string when it is not a parseable date", () => {
    expect(formatAsOf(undefined, "n/a", now)).toBe("n/a");
  });
});
