/**
 * Regression pins for the NYSE exchange-time (ET) alignment
 * (`docs/time_alignment_plan.md`). These lock the day-boundary contract that
 * makes the web companion and the Python desktop agree on when a trading day
 * begins — so the overlay no longer reads a fake ~1% gap from two midnights.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import {
  exchangeDayOf,
  exchangeDayStartMs,
  sessionCloseMs,
} from "../src/market-hours";
import { fetchTimeSeries, type FetchLike } from "../src/prices";
import {
  blobCurveDayMs,
  harvestDailyCloses,
  loadValueHistory,
  recordDailyClose,
} from "../src/value-history";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";
import type { CurvePoint } from "../src/timeseries";

describe("time alignment — ET day boundary", () => {
  // Reference instants computed straight from Python's `_session_start_utc`
  // (00:00 America/New_York → naive UTC), the day-start the desktop stamps at.
  // Pinning the exact epoch-ms guarantees web bar `t` == python sample `t`.
  const PY_SESSION_START_MS: Record<string, number> = {
    "2026-06-26": 1782446400000, // EDT: 04:00Z
    "2026-01-15": 1768453200000, // EST: 05:00Z
    "2026-03-08": 1772946000000, // EST side of the US spring-forward: 05:00Z
    "2026-11-01": 1793505600000, // EDT side of the US fall-back: 04:00Z
  };

  it("exchangeDayStartMs matches Python _session_start_utc to the millisecond", () => {
    for (const [day, ms] of Object.entries(PY_SESSION_START_MS)) {
      expect(exchangeDayStartMs(day)).toBe(ms);
    }
  });

  it("a bare-date day-start is NOT UTC midnight (the Fault-1 offset is real)", () => {
    const utcMidnight = Date.parse("2026-06-26T00:00:00Z");
    // 4h apart in summer — exactly the ~4–5h overlay drift the plan removes.
    expect(exchangeDayStartMs("2026-06-26") - utcMidnight).toBe(4 * 60 * 60 * 1000);
  });

  it("exchangeDayOf round-trips a day-start back to its own ET date", () => {
    for (const day of Object.keys(PY_SESSION_START_MS)) {
      expect(exchangeDayOf(exchangeDayStartMs(day))).toBe(day);
    }
  });

  it("buckets a late-UTC-evening instant onto its NYSE trading day", () => {
    // 2026-06-26 23:30Z is still 19:30 ET on the 26th — a UTC-date bucket would
    // keep it on the 26th here, but a viewer-local bucket west of UTC would not;
    // the ET bucket is unambiguous.
    const t = Date.parse("2026-06-26T23:30:00Z");
    expect(exchangeDayOf(t)).toBe("2026-06-26");
    // ...and 02:00Z on the 27th is still 22:00 ET on the 26th.
    expect(exchangeDayOf(Date.parse("2026-06-27T02:00:00Z"))).toBe("2026-06-26");
  });
});

describe("time alignment — bare-date daily bars (Fault 1)", () => {
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 });

  it("stamps a Twelve Data bare-date daily close at ET day-start", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ values: [{ datetime: "2026-06-26", close: "100" }] });
    const series = await fetchTimeSeries(["VTI"], "key", { fetchImpl });
    const bars = series.get("VTI")!;
    expect(bars).toHaveLength(1);
    expect(bars[0].t).toBe(exchangeDayStartMs("2026-06-26"));
  });

  it("keeps an intraday datetime on its genuine UTC instant", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ values: [{ datetime: "2026-06-26 14:30:00", close: "100" }] });
    const series = await fetchTimeSeries(["VTI"], "key", { fetchImpl });
    expect(series.get("VTI")![0].t).toBe(Date.parse("2026-06-26T14:30:00Z"));
  });
});

describe("time alignment — value-history single bucket (coexistence)", () => {
  function point(t: number, eur: string, usd: string): CurvePoint {
    return { t, valueEur: new Decimal(eur), valueUsd: new Decimal(usd) };
  }

  it("a web-recorded close and a same-day harvested close share one ET bucket", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    // Live tip recorded under an ET `asOf` date string...
    await recordDailyClose(store, {
      date: "2026-06-26",
      valueEur: new Decimal("1000"),
      valueUsd: new Decimal("1080"),
    });
    // ...and the same day harvested from a curve whose instant sits late in the
    // ET session (a UTC-date or viewer-local bucket could split this in two).
    await harvestDailyCloses(store, [
      point(sessionCloseMs("2026-06-26"), "1001", "1081"),
    ]);
    const history = await loadValueHistory(store);
    expect(history).toHaveLength(1);
    expect(history[0].date).toBe("2026-06-26");
  });

  it("blobCurveDayMs files a publisher-local bare date on the ET grid under either schema", () => {
    // The bare date carries no time, so legacy (≤1) and ET (≥2) both resolve to
    // the same ET day-start bucket — the seam is documented, the flip is safe.
    expect(blobCurveDayMs("2026-06-26", 1)).toBe(exchangeDayStartMs("2026-06-26"));
    expect(blobCurveDayMs("2026-06-26", 2)).toBe(exchangeDayStartMs("2026-06-26"));
    expect(blobCurveDayMs("2026-06-26", undefined)).toBe(exchangeDayStartMs("2026-06-26"));
  });
});
