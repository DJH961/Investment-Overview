/**
 * Tests for the value chart's stale-blob backfill (`spliceDailyBackfill`): the
 * device's persisted whole-book daily closes are woven into the gap between the
 * last exported point and today, so a weeks-old blob no longer draws a single
 * straight diagonal across the gap. Pure logic, no DOM.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { EquityPoint } from "../src/phase4";
import type { DailyClose } from "../src/value-history";
import { spliceDailyBackfill } from "../src/ui";

function exported(date: string, eur: string): EquityPoint {
  return {
    date,
    portfolioValue: new Decimal(eur),
    portfolioValueUsd: new Decimal(eur),
    contributions: null,
    benchmarkValue: null,
  };
}

function close(date: string, eur: string, usd: string | null): DailyClose {
  return { date, valueEur: new Decimal(eur), valueUsd: usd === null ? null : new Decimal(usd) };
}

describe("spliceDailyBackfill", () => {
  it("fills the gap between a stale blob's last point and today", () => {
    const points = [exported("2024-03-01", "1000")];
    const backfill = [
      close("2024-03-11", "1010", "1090"),
      close("2024-03-15", "1020", "1100"),
    ];
    // Today (asOf) is owned by the live tip, so only the in-gap days are spliced.
    const result = spliceDailyBackfill(points, backfill, "2024-03-20");
    expect(result.map((p) => p.date)).toEqual(["2024-03-01", "2024-03-11", "2024-03-15"]);
    expect(result[1].portfolioValue!.toString()).toBe("1010");
    expect(result[2].portfolioValueUsd!.toString()).toBe("1100");
  });

  it("drops a non-trading-day close (weekend) — only the prior session's value", () => {
    const points = [exported("2024-03-01", "1000")];
    const backfill = [
      close("2024-03-09", "1015", "1095"), // Saturday — carried-forward, dropped
      close("2024-03-10", "1015", "1095"), // Sunday — carried-forward, dropped
      close("2024-03-11", "1020", "1100"), // Monday — a real session, kept
    ];
    const result = spliceDailyBackfill(points, backfill, "2024-03-20");
    expect(result.map((p) => p.date)).toEqual(["2024-03-01", "2024-03-11"]);
  });

  it("ignores closes on or before the last exported day (the blob covers them)", () => {
    const points = [exported("2024-03-01", "1000"), exported("2024-03-10", "1005")];
    const backfill = [
      close("2024-03-05", "999", "1080"), // already in the blob's range
      close("2024-03-10", "1005", "1085"), // same as the last exported day
      close("2024-03-12", "1010", "1090"), // genuinely new
    ];
    const result = spliceDailyBackfill(points, backfill, "2024-03-20");
    expect(result.map((p) => p.date)).toEqual(["2024-03-01", "2024-03-10", "2024-03-12"]);
  });

  it("never splices today's date — the live tip owns it", () => {
    const points = [exported("2024-03-01", "1000")];
    const backfill = [close("2024-03-20", "1030", "1110")];
    const result = spliceDailyBackfill(points, backfill, "2024-03-20");
    expect(result.map((p) => p.date)).toEqual(["2024-03-01"]);
  });

  it("returns the original points unchanged when there is no backfill", () => {
    const points = [exported("2024-03-01", "1000")];
    expect(spliceDailyBackfill(points, [], "2024-03-20")).toBe(points);
  });

  it("returns the original points when a fresh blob already covers the range", () => {
    const points = [exported("2024-03-19", "1000")];
    // Every stored close is on/before the last exported day → nothing to add.
    const backfill = [close("2024-03-18", "990", "1070"), close("2024-03-19", "1000", "1080")];
    const result = spliceDailyBackfill(points, backfill, "2024-03-20");
    expect(result).toEqual(points);
  });

  it("preserves a null USD leg on a spliced close", () => {
    const points = [exported("2024-03-01", "1000")];
    const result = spliceDailyBackfill(points, [close("2024-03-11", "1010", null)], "2024-03-20");
    expect(result[1].portfolioValueUsd).toBeNull();
    expect(result[1].portfolioValue!.toString()).toBe("1010");
  });
});
