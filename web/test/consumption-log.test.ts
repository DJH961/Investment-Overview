import { beforeEach, describe, expect, it } from "vitest";
import Decimal from "decimal.js";

import {
  appendConsumptionSnapshot,
  clearConsumptionLog,
  formatConsumptionLog,
  readConsumptionLog,
  recordConsumption,
  summariseConsumption,
  MAX_CONSUMPTION_SNAPSHOTS,
} from "../src/consumption-log";
import type { DashboardModel, HoldingView, OverviewView } from "../src/compute";
import type { StorageLike } from "../src/cache";

/** An in-memory StorageLike for deterministic, isolated tests. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** A minimal HoldingView carrying only the fields the summariser reads. */
function holding(symbol: string, opts: Partial<HoldingView> = {}): HoldingView {
  return {
    symbol,
    priceIsLive: true,
    todayMoveIsStale: false,
    ...opts,
  } as HoldingView;
}

/** A minimal, "perfect" overview the summariser can read. */
function overview(opts: Partial<OverviewView> = {}): OverviewView {
  return {
    eurUsdSource: "live",
    fxMissingCurrencies: [],
    missingPriceSymbols: [],
    staleValueSymbols: [],
    totalValueIsComplete: true,
    totalValueUsd: new Decimal("1000"),
    totalGainPctUsd: new Decimal("0.1"),
    todayMovePctUsd: new Decimal("0.01"),
    mtdGrowthPctUsd: new Decimal("0.02"),
    ytdGrowthPctUsd: new Decimal("0.03"),
    portfolioXirrUsd: new Decimal("0.05"),
    totalGrowthCompoundedPctUsd: new Decimal("0.4"),
    totalGainPct: new Decimal("0.1"),
    portfolioXirr: new Decimal("0.05"),
    mtdGrowthPct: new Decimal("0.02"),
    ytdGrowthPct: new Decimal("0.03"),
    liveDegradedReason: null,
    ...opts,
  } as OverviewView;
}

function model(o: Partial<OverviewView>, holdings: HoldingView[], valueBackfill?: DashboardModel["valueBackfill"]): DashboardModel {
  return { overview: overview(o), holdings, valueBackfill } as unknown as DashboardModel;
}

describe("consumption-log summariser", () => {
  it("reports a perfect read when every view had ideal data", () => {
    const s = summariseConsumption(model({}, [holding("AAPL"), holding("MSFT")]));
    expect(s.perfect).toBe(true);
    expect(s.needed).toEqual([]);
    expect(s.holdings.flags).toEqual([]);
    expect(s.currency.flags).toEqual([]);
    expect(s.graph.flags).toEqual([]);
    expect(s.holdings.summary).toContain("2 live");
  });

  it("flags a holding that fell back to its last exported value as a warn", () => {
    const s = summariseConsumption(
      model({ staleValueSymbols: ["MSFT"] }, [holding("AAPL"), holding("MSFT", { priceIsLive: false })]),
    );
    expect(s.perfect).toBe(false);
    expect(s.holdings.flags.some((f) => f.level === "warn" && f.message.includes("MSFT"))).toBe(true);
    expect(s.needed.some((n) => n.includes("MSFT"))).toBe(true);
  });

  it("flags an unpriced holding dropped from totals as an error", () => {
    const s = summariseConsumption(model({ missingPriceSymbols: ["XYZ"] }, [holding("XYZ", { priceIsLive: false })]));
    expect(s.holdings.flags.some((f) => f.level === "error" && f.message.includes("XYZ"))).toBe(true);
  });

  it("flags a missing EUR/USD rate as an error and needs a spot", () => {
    const s = summariseConsumption(model({ eurUsdSource: "none", totalValueUsd: null }, [holding("AAPL")]));
    expect(s.currency.flags.some((f) => f.level === "error")).toBe(true);
    expect(s.needed).toContain("an EUR/USD spot rate");
  });

  it("flags the keyless end-of-day FX rate as a warn", () => {
    const s = summariseConsumption(model({ eurUsdSource: "eod" }, [holding("AAPL")]));
    expect(s.currency.flags.some((f) => f.level === "warn" && /end-of-day/.test(f.message))).toBe(true);
    expect(s.currency.perfect).toBe(false);
  });

  it("flags a missing USD KPI companion as an EUR fallback", () => {
    const s = summariseConsumption(model({ totalGainPctUsd: null }, [holding("AAPL")]));
    expect(s.currency.flags.some((f) => f.message.includes("total gain %"))).toBe(true);
  });

  it("flags an incomplete book so the chart cannot draw today's tip", () => {
    const s = summariseConsumption(model({ totalValueIsComplete: false }, [holding("AAPL")]));
    expect(s.graph.flags.some((f) => f.message.includes("could not draw today's live tip"))).toBe(true);
    expect(s.graph.perfect).toBe(false);
  });

  it("notes a device backfill bridging a stale data file as info", () => {
    const s = summariseConsumption(
      model({}, [holding("AAPL")], [{ date: "2024-06-01", valueEur: "10" } as never, { date: "2024-06-02", valueEur: "11" } as never]),
    );
    expect(s.graph.flags.some((f) => f.level === "info" && f.message.includes("2 day(s)"))).toBe(true);
    expect(s.graph.perfect).toBe(false);
  });
});

describe("consumption-log persistence", () => {
  let storage: StorageLike;
  beforeEach(() => {
    storage = memoryStorage();
    clearConsumptionLog(storage);
  });

  it("merges consecutive identical states, bumping count and lastAt", () => {
    const m = model({}, [holding("AAPL")]);
    recordConsumption(m, { at: 1_000, storage });
    recordConsumption(m, { at: 2_000, storage });
    recordConsumption(m, { at: 3_000, storage });
    const log = readConsumptionLog(storage);
    expect(log.length).toBe(1);
    expect(log[0].count).toBe(3);
    expect(log[0].at).toBe(1_000);
    expect(log[0].lastAt).toBe(3_000);
  });

  it("opens a new row when the flagged picture changes", () => {
    recordConsumption(model({}, [holding("AAPL")]), { at: 1_000, storage });
    recordConsumption(model({ staleValueSymbols: ["AAPL"] }, [holding("AAPL", { priceIsLive: false })]), { at: 2_000, storage });
    const log = readConsumptionLog(storage);
    expect(log.length).toBe(2);
    expect(log[0].perfect).toBe(true);
    expect(log[1].perfect).toBe(false);
  });

  it("caps the log at MAX_CONSUMPTION_SNAPSHOTS, keeping the newest", () => {
    for (let i = 0; i < MAX_CONSUMPTION_SNAPSHOTS + 20; i++) {
      // Each state differs (unique missing symbol) so none are merged.
      appendConsumptionSnapshot(
        summariseConsumption(model({ missingPriceSymbols: [`S${i}`] }, [holding(`S${i}`, { priceIsLive: false })])),
        { at: 1_000 + i, storage },
      );
    }
    const log = readConsumptionLog(storage);
    expect(log.length).toBe(MAX_CONSUMPTION_SNAPSHOTS);
    expect(log[log.length - 1].holdings.flags.some((f) => f.message.includes(`S${MAX_CONSUMPTION_SNAPSHOTS + 19}`))).toBe(true);
  });
});

describe("consumption-log report", () => {
  it("renders an empty-state report", () => {
    const text = formatConsumptionLog([]);
    expect(text).toContain("data loading (consumption) log");
    expect(text).toContain("(no overview reads recorded yet)");
  });

  it("renders perfect and degraded states with a needed verdict", () => {
    const storage = memoryStorage();
    clearConsumptionLog(storage);
    recordConsumption(model({}, [holding("AAPL")]), { at: 1_000, storage });
    recordConsumption(model({ staleValueSymbols: ["AAPL"] }, [holding("AAPL", { priceIsLive: false })]), { at: 2_000, storage });
    const text = formatConsumptionLog(readConsumptionLog(storage), { version: "test" });
    expect(text).toContain("Distinct read states: 2");
    expect(text).toContain("Degraded states: 1");
    expect(text).toContain("PERFECT");
    expect(text).toContain("DEGRADED");
    expect(text).toContain("Needed to be perfect:");
  });
});
