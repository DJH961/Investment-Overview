/**
 * Tests for the IndexedDB-backed time-series store, exercised through the
 * injectable in-memory backend (no browser required).
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { Bar } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore, type StoredSession } from "../src/timeseries-store";

function bar(t: number, value: string): Bar {
  return { t, value: new Decimal(value) };
}

function session(day: string): StoredSession {
  return {
    day,
    bars: { VTI: [bar(100, "50"), bar(200, "55")] },
    fx: [bar(100, "1.1")],
    updatedAt: 1000,
  };
}

describe("TimeSeriesStore", () => {
  it("round-trips a session, preserving Decimal precision", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-10"));
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded).not.toBeNull();
    expect(loaded!.bars.VTI[1].value.toString()).toBe("55");
    expect(loaded!.fx[0].value.toString()).toBe("1.1");
    expect(loaded!.updatedAt).toBe(1000);
  });

  it("returns null for an unknown day", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    expect(await store.loadSession("1999-01-01")).toBeNull();
  });

  it("merges incoming bars without re-fetching the whole day", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-10"));
    const merged = await store.mergeSession(
      "2024-01-10",
      { bars: { VTI: [bar(300, "60")], SPY: [bar(100, "400")] }, fx: [bar(200, "1.2")] },
      2000,
    );
    expect(merged.bars.VTI.map((b) => b.t)).toEqual([100, 200, 300]); // appended
    expect(merged.bars.SPY).toHaveLength(1); // new symbol
    expect(merged.fx.map((b) => b.t)).toEqual([100, 200]);
    expect(merged.updatedAt).toBe(2000);
  });

  it("lets a corrected bar at the same instant win on merge", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-10"));
    const merged = await store.mergeSession("2024-01-10", { bars: { VTI: [bar(200, "56")] } });
    const at200 = merged.bars.VTI.find((b) => b.t === 200)!;
    expect(at200.value.toString()).toBe("56"); // replaced 55
  });

  it("merges into a brand-new day when none exists yet", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const merged = await store.mergeSession("2024-02-01", { bars: { VTI: [bar(100, "50")] } });
    expect(merged.day).toBe("2024-02-01");
    expect(merged.bars.VTI).toHaveLength(1);
  });

  it("prunes days strictly before the retained window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    for (const day of ["2024-01-08", "2024-01-09", "2024-01-10"]) {
      await store.saveSession(session(day));
    }
    await store.prune("2024-01-09");
    expect(await store.listDays()).toEqual(["2024-01-09", "2024-01-10"]);
  });

  it("never prunes a namespaced (non-date) cache key", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-08"));
    await store.saveSession({ ...session("2024-01-10"), day: "1W-daily" });
    // A date floor far in the future would lexically exceed the namespaced key,
    // but it must survive a session prune regardless.
    await store.prune("2099-01-01");
    expect(await store.listDays()).toContain("1W-daily");
    expect(await store.listDays()).not.toContain("2024-01-08");
  });

  it("clear() wipes every record — dated sessions and namespaced caches", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-08"));
    await store.saveSession(session("2024-01-10"));
    await store.saveSession({ ...session("2024-01-10"), day: "1W-daily" });
    await store.clear();
    expect(await store.listDays()).toEqual([]);
    expect(await store.loadSession("2024-01-10")).toBeNull();
  });

  it("deleteSession() drops only the named record, leaving the rest intact", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-08"));
    await store.saveSession(session("2024-01-10"));
    await store.saveSession({ ...session("2024-01-10"), day: "1W-daily" });
    // Drop the namespaced 1W cache (the "Regenerate 1W graph" path) — dated days survive.
    await store.deleteSession("1W-daily");
    expect(await store.listDays()).toEqual(["2024-01-08", "2024-01-10"]);
    expect(await store.loadSession("1W-daily")).toBeNull();
    // Drop a single trading day (the "Regenerate 1D graph" path) — the other remains.
    await store.deleteSession("2024-01-10");
    expect(await store.listDays()).toEqual(["2024-01-08"]);
  });

  it("deleteSession() is a no-op for an absent key", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-10"));
    await store.deleteSession("2099-12-31");
    expect(await store.listDays()).toEqual(["2024-01-10"]);
  });

  it("round-trips live-tip breadcrumbs preserving precision", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession({
      ...session("2024-01-10"),
      tips: [{ t: 300, valueEur: new Decimal("1000.5"), valueUsd: new Decimal("1100.25") }],
    });
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.tips).toHaveLength(1);
    expect(loaded!.tips![0].valueEur.toString()).toBe("1000.5");
    expect(loaded!.tips![0].valueUsd.toString()).toBe("1100.25");
  });

  it("treats a session without a tips field as an empty trail", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-10")); // no tips
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.tips).toEqual([]);
  });

  it("appendTip accumulates a trail once breadcrumbs are spaced out", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const tip = (t: number, v: string) => ({
      t,
      valueEur: new Decimal(v),
      valueUsd: new Decimal(v),
    });
    await store.appendTip("2024-01-10", tip(0, "100"));
    await store.appendTip("2024-01-10", tip(60_000, "101"));
    await store.appendTip("2024-01-10", tip(120_000, "102"));
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.tips!.map((p) => p.valueEur.toString())).toEqual(["100", "101", "102"]);
  });

  it("appendTip decimates breadcrumbs closer than the spacing window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const tip = (t: number, v: string) => ({
      t,
      valueEur: new Decimal(v),
      valueUsd: new Decimal(v),
    });
    await store.appendTip("2024-01-10", tip(0, "100"));
    // Within the 1-minute default spacing — replaces the tail rather than crowd it.
    await store.appendTip("2024-01-10", tip(10_000, "100.5"));
    await store.appendTip("2024-01-10", tip(30_000, "101"));
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.tips!.map((p) => [p.t, p.valueEur.toString()])).toEqual([[30_000, "101"]]);
  });

  it("appendTip caps the trail at the most-recent maxTips", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    for (let i = 0; i < 5; i += 1) {
      await store.appendTip(
        "2024-01-10",
        { t: i * 60_000, valueEur: new Decimal(i), valueUsd: new Decimal(i) },
        { maxTips: 3 },
      );
    }
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.tips!.map((p) => p.valueEur.toString())).toEqual(["2", "3", "4"]);
  });

  it("appendTip does not bump updatedAt (never fools the bar-refetch throttle)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession({ ...session("2024-01-10"), updatedAt: 5000 });
    await store.appendTip("2024-01-10", {
      t: 9_999_999,
      valueEur: new Decimal("1"),
      valueUsd: new Decimal("1"),
    });
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.updatedAt).toBe(5000);
  });

  it("mergeSession preserves an existing breadcrumb trail", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.appendTip("2024-01-10", {
      t: 100,
      valueEur: new Decimal("1"),
      valueUsd: new Decimal("1"),
    });
    await store.mergeSession("2024-01-10", { bars: { VTI: [bar(300, "60")] } }, 7000);
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.tips).toHaveLength(1);
    expect(loaded!.bars.VTI.at(-1)!.value.toString()).toBe("60");
    expect(loaded!.updatedAt).toBe(7000);
  });

  it("round-trips a per-symbol closeProbe record (C1)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession({
      ...session("2024-01-10"),
      closeProbe: {
        DAX: { lastBarAt: 1234, attempts: 2, sources: 2, settled: true, lastAttemptAt: 5678 },
      },
    });
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.closeProbe!.DAX).toEqual({
      lastBarAt: 1234,
      attempts: 2,
      sources: 2,
      settled: true,
      lastAttemptAt: 5678,
    });
  });

  it("deserialises a legacy payload without closeProbe to undefined (C1)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.saveSession(session("2024-01-10")); // no closeProbe
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.closeProbe).toBeUndefined();
  });

  it("a {bars}-only mergeSession preserves an existing settled:true probe (C1)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2024-01-10", {
      closeProbe: {
        DAX: { lastBarAt: 100, attempts: 1, sources: 2, settled: true, lastAttemptAt: 10 },
      },
    });
    await store.mergeSession("2024-01-10", { bars: { DAX: [bar(300, "60")] } }, 7000);
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.closeProbe!.DAX.settled).toBe(true);
    expect(loaded!.bars.DAX.at(-1)!.value.toString()).toBe("60");
  });

  it("keeps settled sticky when a later probe carries settled:false (C1/P3)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2024-01-10", {
      closeProbe: {
        DAX: { lastBarAt: 100, attempts: 1, sources: 2, settled: true, lastAttemptAt: 10 },
      },
    });
    await store.mergeSession("2024-01-10", {
      closeProbe: {
        DAX: { lastBarAt: 100, attempts: 2, sources: 1, settled: false, lastAttemptAt: 20 },
      },
    });
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.closeProbe!.DAX.settled).toBe(true);
    expect(loaded!.closeProbe!.DAX.attempts).toBe(2); // other fields take the new value
  });

  it("closeProbeClear drops a symbol's probe (reached-close) (C1)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2024-01-10", {
      closeProbe: {
        DAX: { lastBarAt: 100, attempts: 1, sources: 1, settled: false, lastAttemptAt: 10 },
      },
    });
    await store.mergeSession("2024-01-10", { bars: { DAX: [bar(9, "1")] }, closeProbeClear: ["DAX"] });
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.closeProbe).toBeUndefined();
  });

  it("appendTip preserves the closeProbe memory (C1)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2024-01-10", {
      closeProbe: {
        DAX: { lastBarAt: 100, attempts: 1, sources: 2, settled: true, lastAttemptAt: 10 },
      },
    });
    await store.appendTip("2024-01-10", {
      t: 500,
      valueEur: new Decimal("1"),
      valueUsd: new Decimal("1"),
    });
    const loaded = await store.loadSession("2024-01-10");
    expect(loaded!.closeProbe!.DAX.settled).toBe(true);
  });
});
