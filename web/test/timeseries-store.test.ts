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
});
