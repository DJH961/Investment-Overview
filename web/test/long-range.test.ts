/**
 * Tests for the long-range whole-book value-history reconstruction
 * (`long-range.ts`): the pure window/gap maths, the daily-close reconstruction,
 * and the injectable orchestrator (no DOM, IndexedDB, or live API).
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { IntradayAnchor, IntradayHolding } from "../src/intraday";
import {
  LONG_RANGE_MAX_LOOKBACK_DAYS,
  loadOrBuildLongRangeHistory,
  longRangeGapDays,
  longRangeWindow,
  reconstructLongRangeCloses,
  tradingDaysInWindow,
} from "../src/long-range";
import type { Bar } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";
import { loadValueHistory, recordDailyClose } from "../src/value-history";

function holding(partial: Partial<IntradayHolding> & { priceSymbol: string }): IntradayHolding {
  return {
    valueEur: new Decimal("90"),
    valueUsd: new Decimal("100"),
    closeNative: new Decimal("10"),
    isUsdNative: true,
    priceType: "market",
    ...partial,
  };
}

function anchor(holdings: IntradayHolding[]): IntradayAnchor {
  return {
    holdings,
    baseEur: new Decimal("10"),
    baseUsd: new Decimal("10"),
    baseFx: null,
  };
}

/** A daily-close bar stamped at local 16:00 of `YYYY-MM-DD` (unambiguous local day). */
function dailyBar(date: string, value: string): Bar {
  const [y, m, d] = date.split("-").map(Number);
  return { t: new Date(y, m - 1, d, 16, 0).getTime(), value: new Decimal(value) };
}

describe("longRangeWindow", () => {
  it("returns null when a fresh blob already covers up to today", () => {
    expect(longRangeWindow({ today: "2024-03-05", lastExportDay: "2024-03-05" })).toBeNull();
  });

  it("starts the day after the blob's last export", () => {
    expect(longRangeWindow({ today: "2024-03-05", lastExportDay: "2024-03-01" })).toEqual({
      startDate: "2024-03-02",
      endDate: "2024-03-05",
    });
  });

  it("reaches the full look-back when there is no blob", () => {
    const w = longRangeWindow({ today: "2024-06-01", lastExportDay: null });
    expect(w).not.toBeNull();
    expect(w!.endDate).toBe("2024-06-01");
    // 365 calendar days before 2024-06-01.
    expect(w!.startDate).toBe("2023-06-02");
  });

  it("caps a heavily-stale blob at the look-back horizon", () => {
    const w = longRangeWindow({ today: "2024-06-01", lastExportDay: "2020-01-01" });
    expect(w!.startDate).toBe("2023-06-02"); // not 2020-01-02 — capped to 1Y
  });

  it("honours a custom look-back", () => {
    const w = longRangeWindow({ today: "2024-06-01", lastExportDay: null, maxLookbackDays: 30 });
    expect(w!.startDate).toBe("2024-05-02");
  });

  it("uses a 1-year default horizon", () => {
    expect(LONG_RANGE_MAX_LOOKBACK_DAYS).toBe(365);
  });

  // Blob-basis contract (new requirement): the reconstruction is only ever a
  // gap-filler layered on top of the blob — it must never reach into the range
  // the blob's analytics.curve already covers. So whenever a blob is present the
  // window must start strictly *after* its last export, leaving every
  // blob-covered day (with its reinvestment/share history) untouched.
  it("never reaches on or before the blob's last export (gap-filler only)", () => {
    for (const lastExportDay of ["2024-03-01", "2024-02-15", "2023-12-31", "2020-01-01"]) {
      const w = longRangeWindow({ today: "2024-03-05", lastExportDay });
      expect(w).not.toBeNull();
      expect(w!.startDate > lastExportDay).toBe(true);
    }
  });
});

describe("tradingDaysInWindow", () => {
  it("lists the NYSE sessions in the window, skipping weekends", () => {
    // 2024-03-02 Sat, 03-03 Sun, 03-04 Mon, 03-05 Tue.
    expect(tradingDaysInWindow({ startDate: "2024-03-02", endDate: "2024-03-05" })).toEqual([
      "2024-03-04",
      "2024-03-05",
    ]);
  });

  it("ends on the latest session on or before a non-trading endDate", () => {
    // endDate 2024-03-03 (Sun) → latest session is Fri 03-01.
    expect(tradingDaysInWindow({ startDate: "2024-02-29", endDate: "2024-03-03" })).toEqual([
      "2024-02-29",
      "2024-03-01",
    ]);
  });
});

describe("longRangeGapDays", () => {
  it("returns the days the history is missing", () => {
    const history = [
      { date: "2024-03-04", valueEur: new Decimal("1"), valueUsd: new Decimal("1") },
    ];
    expect(longRangeGapDays(history, ["2024-03-04", "2024-03-05"])).toEqual(["2024-03-05"]);
  });

  it("is empty when every day is already covered", () => {
    const history = [
      { date: "2024-03-04", valueEur: new Decimal("1"), valueUsd: new Decimal("1") },
      { date: "2024-03-05", valueEur: new Decimal("1"), valueUsd: new Decimal("1") },
    ];
    expect(longRangeGapDays(history, ["2024-03-04", "2024-03-05"])).toEqual([]);
  });
});

describe("reconstructLongRangeCloses", () => {
  it("re-marks each holding's settled value at the day's daily close", () => {
    const points = reconstructLongRangeCloses({
      anchor: anchor([holding({ priceSymbol: "AAA" })]),
      barsBySymbol: new Map([["AAA", [dailyBar("2024-03-04", "8")]]]),
    });
    expect(points).toHaveLength(1);
    // ratio = 8/10 = 0.8 → USD = base 10 + 100*0.8 = 90; EUR = base 10 + 90*0.8 = 82.
    expect(points[0].valueUsd.toString()).toBe("90");
    expect(points[0].valueEur.toString()).toBe("82");
  });
});

describe("loadOrBuildLongRangeHistory", () => {
  const base = { today: "2024-03-05", lastExportDay: "2024-03-01" } as const;

  it("reconstructs and harvests the gap when the store is empty", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const requested: string[][] = [];
    const result = await loadOrBuildLongRangeHistory({
      ...base,
      anchor: anchor([holding({ priceSymbol: "AAA" })]),
      store,
      fetchDailyBars: async (syms) => {
        requested.push(syms);
        return new Map([
          ["AAA", [dailyBar("2024-03-04", "8"), dailyBar("2024-03-05", "9")]],
        ]);
      },
    });
    expect(result.fetched).toBe(true);
    expect(requested).toEqual([["AAA"]]);
    expect(result.history.map((c) => c.date)).toEqual(["2024-03-04", "2024-03-05"]);
    const stored = await loadValueHistory(store);
    expect(stored.map((c) => c.date)).toEqual(["2024-03-04", "2024-03-05"]);
  });

  it("skips the network when the store already covers the window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    for (const date of ["2024-03-04", "2024-03-05"]) {
      await recordDailyClose(store, { date, valueEur: new Decimal("1"), valueUsd: new Decimal("1") });
    }
    let fetched = false;
    const result = await loadOrBuildLongRangeHistory({
      ...base,
      anchor: anchor([holding({ priceSymbol: "AAA" })]),
      store,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map();
      },
    });
    expect(fetched).toBe(false);
    expect(result.fetched).toBe(false);
    expect(result.gapDays).toEqual([]);
  });

  it("force re-fetches even when the store already covers the window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    for (const date of ["2024-03-04", "2024-03-05"]) {
      await recordDailyClose(store, { date, valueEur: new Decimal("1"), valueUsd: new Decimal("1") });
    }
    let fetched = false;
    const result = await loadOrBuildLongRangeHistory({
      ...base,
      force: true,
      anchor: anchor([holding({ priceSymbol: "AAA" })]),
      store,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map([["AAA", [dailyBar("2024-03-04", "8")]]]);
      },
    });
    expect(fetched).toBe(true);
    expect(result.fetched).toBe(true);
  });

  // Blob-basis contract (new requirement): even if a fetcher returns bars from
  // *before* the blob's last export, the reconstruction must never harvest those
  // blob-covered days — it is strictly a gap-filler on top of the blob.
  it("never harvests a day on or before the blob's last export", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const result = await loadOrBuildLongRangeHistory({
      ...base, // lastExportDay: "2024-03-01"
      anchor: anchor([holding({ priceSymbol: "AAA" })]),
      store,
      fetchDailyBars: async () =>
        new Map([
          [
            "AAA",
            [
              dailyBar("2024-02-28", "5"), // before the blob's export — must be ignored
              dailyBar("2024-03-01", "6"), // the blob's last export day — must be ignored
              dailyBar("2024-03-04", "8"), // in the gap — kept
              dailyBar("2024-03-05", "9"), // in the gap — kept
            ],
          ],
        ]),
    });
    expect(result.fetched).toBe(true);
    expect(result.history.map((c) => c.date)).toEqual(["2024-03-04", "2024-03-05"]);
    const stored = await loadValueHistory(store);
    expect(stored.map((c) => c.date)).toEqual(["2024-03-04", "2024-03-05"]);
  });

  it("only fetches the market sleeve, never NAV funds", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const requested: string[][] = [];
    await loadOrBuildLongRangeHistory({
      ...base,
      anchor: anchor([
        holding({ priceSymbol: "AAA", priceType: "market" }),
        holding({ priceSymbol: "FUND", priceType: "nav" }),
      ]),
      store,
      fetchDailyBars: async (syms) => {
        requested.push(syms);
        return new Map([["AAA", [dailyBar("2024-03-04", "8")]]]);
      },
    });
    expect(requested).toEqual([["AAA"]]);
  });

  it("is a no-op for an anchor with no holdings", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    let fetched = false;
    const result = await loadOrBuildLongRangeHistory({
      ...base,
      anchor: anchor([]),
      store,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map();
      },
    });
    expect(fetched).toBe(false);
    expect(result.fetched).toBe(false);
  });

  it("leaves the store untouched when the fetch throws", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const result = await loadOrBuildLongRangeHistory({
      ...base,
      anchor: anchor([holding({ priceSymbol: "AAA" })]),
      store,
      fetchDailyBars: async () => {
        throw new Error("network down");
      },
    });
    expect(result.fetched).toBe(false);
    expect(await loadValueHistory(store)).toEqual([]);
  });

  it("re-marks the EUR pivot at each day's settled FX when FX bars are supplied", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const result = await loadOrBuildLongRangeHistory({
      ...base,
      anchor: { ...anchor([holding({ priceSymbol: "AAA" })]), baseFx: new Decimal("1.1") },
      store,
      fetchDailyBars: async () => new Map([["AAA", [dailyBar("2024-03-04", "10")]]]),
      fetchFx: async () => [dailyBar("2024-03-04", "1.25")],
    });
    expect(result.fetched).toBe(true);
    // ratio 10/10 = 1 → USD = 10 + 100 = 110 (FX-free).
    expect(result.history[0].valueUsd!.toString()).toBe("110");
    // EUR pivot re-marked from baseFx 1.1 to the day's 1.25: 90 * 1.1/1.25 = 79.2; + base 10.
    expect(result.history[0].valueEur.toString()).toBe("89.2");
  });
});
