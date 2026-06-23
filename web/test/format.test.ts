/**
 * Tests for the per-holding "as of" freshness label. Locale-dependent strings
 * are asserted loosely (non-empty / contains a separator) to stay portable.
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

import {
  formatAsOf,
  formatCurrencyShortRaw,
  formatDailyGrowthAsOf,
  formatLastPull,
  formatUpdatedAt,
} from "../src/format";

describe("formatDailyGrowthAsOf", () => {
  const today = "2026-06-22";

  it("shows a live clock time when the market is open and we have today's intraday obs", () => {
    const liveAsOf = new Date("2026-06-22T18:11:00Z").getTime();
    const out = formatDailyGrowthAsOf(liveAsOf, today, today, true, new Date("2026-06-22T18:12:00Z"));
    expect(out).toMatch(/^as of \d{1,2}:\d{2}/);
  });

  it("pins to the settled day ('as of today') when the market is closed", () => {
    const liveAsOf = new Date("2026-06-22T18:11:00Z").getTime();
    const out = formatDailyGrowthAsOf(liveAsOf, today, today, false, new Date("2026-06-22T22:00:00Z"));
    expect(out).toBe("as of today");
  });

  it("shows the weekday + date for an earlier settled day", () => {
    const out = formatDailyGrowthAsOf(null, "2026-06-19", today, false, new Date("2026-06-22T12:00:00Z"));
    expect(out).toMatch(/^as of /);
    expect(out).not.toBe("as of today");
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("does not claim live wording when the freshest obs predates today even if open", () => {
    const liveAsOf = new Date("2026-06-19T18:11:00Z").getTime();
    const out = formatDailyGrowthAsOf(liveAsOf, "2026-06-19", today, true, new Date("2026-06-22T14:00:00Z"));
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

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

describe("formatUpdatedAt", () => {
  const now = new Date("2024-06-01T15:30:00Z");

  it("shows just a clock time when the update was today", () => {
    const at = new Date("2024-06-01T09:05:00Z").getTime();
    const out = formatUpdatedAt(at, "2024-05-01", now);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("keeps the clock time (with a date) even when the update was before today", () => {
    const at = new Date("2024-05-20T09:05:00Z").getTime();
    const out = formatUpdatedAt(at, "2024-05-01", now);
    // Unlike formatAsOf, the time is never dropped for an older observation.
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("falls back to the export date when nothing was priced live", () => {
    const out = formatUpdatedAt(null, "2024-05-20", now);
    expect(out).not.toMatch(/:/);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("formatLastPull", () => {
  const now = new Date("2024-06-01T15:30:00Z");

  it("says 'today' with a clock time for a pull earlier today", () => {
    const at = new Date("2024-06-01T09:05:00Z").getTime();
    const out = formatLastPull(at, now);
    expect(out).toMatch(/^today at \d{1,2}:\d{2}/);
  });

  it("says 'yesterday' with a clock time for a pull the day before", () => {
    const at = new Date("2024-05-31T18:05:00Z").getTime();
    const out = formatLastPull(at, now);
    expect(out).toMatch(/^yesterday at \d{1,2}:\d{2}/);
  });

  it("shows the date (and time) for an older pull", () => {
    const at = new Date("2024-05-20T09:05:00Z").getTime();
    const out = formatLastPull(at, now);
    expect(out).not.toMatch(/^(today|yesterday)/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("reports 'not yet' when no pull has happened", () => {
    expect(formatLastPull(null, now)).toBe("not yet");
    expect(formatLastPull(undefined, now)).toBe("not yet");
  });
});

describe("formatCurrencyShortRaw", () => {
  it("formats an amount already in the given currency without FX conversion", () => {
    // USD is native: the value must NOT be re-scaled, only labelled with $.
    expect(formatCurrencyShortRaw(new Decimal(33000), "USD")).toBe("$33k");
    expect(formatCurrencyShortRaw(new Decimal(1_250_000), "USD")).toBe("$1.3M");
    expect(formatCurrencyShortRaw(new Decimal(30000), "EUR")).toBe("€30k");
    expect(formatCurrencyShortRaw(new Decimal(-2500), "USD")).toBe("−$2.5k");
  });

  it("renders an em dash for a null value", () => {
    expect(formatCurrencyShortRaw(null, "USD")).toBe("—");
  });
});
