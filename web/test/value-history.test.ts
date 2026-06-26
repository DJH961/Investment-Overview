/**
 * Tests for the whole-book daily-close history that backfills the long-range
 * value graph (`value-history.ts`), exercised through the injectable in-memory
 * TimeSeriesStore backend (no browser required).
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { CurvePoint } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";
import {
  VALUE_HISTORY_STORE_KEY,
  recordDailyClose,
  loadValueHistory,
  harvestDailyCloses,
  pruneValueHistory,
} from "../src/value-history";

// Local midnight of a `YYYY-MM-DD` — mirrors value-history's own day stamping, which
// is local (not UTC) to match the Python blob's bare-date `date.today()` calendar.
const dayMs = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

function point(t: number, eur: string, usd: string): CurvePoint {
  return { t, valueEur: new Decimal(eur), valueUsd: new Decimal(usd) };
}

describe("value-history", () => {
  it("records and loads a daily close in both currencies", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await recordDailyClose(store, {
      date: "2024-03-01",
      valueEur: new Decimal("1000"),
      valueUsd: new Decimal("1080"),
    });
    const history = await loadValueHistory(store);
    expect(history).toEqual([
      { date: "2024-03-01", valueEur: new Decimal("1000"), valueUsd: new Decimal("1080") },
    ]);
  });

  it("keeps the closes ascending by day regardless of write order", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await recordDailyClose(store, { date: "2024-03-03", valueEur: new Decimal("30"), valueUsd: new Decimal("33") });
    await recordDailyClose(store, { date: "2024-03-01", valueEur: new Decimal("10"), valueUsd: new Decimal("11") });
    await recordDailyClose(store, { date: "2024-03-02", valueEur: new Decimal("20"), valueUsd: new Decimal("22") });
    const history = await loadValueHistory(store);
    expect(history.map((c) => c.date)).toEqual(["2024-03-01", "2024-03-02", "2024-03-03"]);
  });

  it("overwrites the same day when re-recorded (a settling total refines)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await recordDailyClose(store, { date: "2024-03-01", valueEur: new Decimal("1000"), valueUsd: new Decimal("1080") });
    await recordDailyClose(store, { date: "2024-03-01", valueEur: new Decimal("1005"), valueUsd: new Decimal("1085") });
    const history = await loadValueHistory(store);
    expect(history).toHaveLength(1);
    expect(history[0].valueEur.toString()).toBe("1005");
    expect(history[0].valueUsd!.toString()).toBe("1085");
  });

  it("yields a null USD leg when only EUR was recorded", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await recordDailyClose(store, { date: "2024-03-01", valueEur: new Decimal("1000"), valueUsd: null });
    const history = await loadValueHistory(store);
    expect(history[0].valueUsd).toBeNull();
  });

  it("returns an empty history when nothing is stored", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    expect(await loadValueHistory(store)).toEqual([]);
  });

  it("does not collide with dated session keys (namespaced storage)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await recordDailyClose(store, { date: "2024-03-01", valueEur: new Decimal("1000"), valueUsd: new Decimal("1080") });
    // The history lives under its namespaced key, not a YYYY-MM-DD session.
    expect(await store.listDays()).toEqual([VALUE_HISTORY_STORE_KEY]);
    // A session prune (rolling 1W window) must never sweep the history away.
    await store.prune("2099-01-01");
    expect(await loadValueHistory(store)).toHaveLength(1);
  });

  describe("harvestDailyCloses", () => {
    it("takes the latest-timestamp point of each local day as that day's close", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      const points: CurvePoint[] = [
        point(dayMs("2024-03-01") + 1, "10", "11"),
        point(dayMs("2024-03-01") + 2, "12", "13"), // later same day → wins
        point(dayMs("2024-03-02") + 5, "20", "22"),
      ];
      await harvestDailyCloses(store, points);
      const history = await loadValueHistory(store);
      expect(history).toEqual([
        { date: "2024-03-01", valueEur: new Decimal("12"), valueUsd: new Decimal("13") },
        { date: "2024-03-02", valueEur: new Decimal("20"), valueUsd: new Decimal("22") },
      ]);
    });

    it("resolves a day's close by latest timestamp, not curve order", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      // Same day, fed out of order: the genuinely later instant must still win.
      await harvestDailyCloses(store, [
        point(dayMs("2024-03-01") + 9, "99", "108"), // latest instant
        point(dayMs("2024-03-01") + 1, "10", "11"),
      ]);
      const history = await loadValueHistory(store);
      expect(history).toEqual([
        { date: "2024-03-01", valueEur: new Decimal("99"), valueUsd: new Decimal("108") },
      ]);
    });

    it("skips points with a non-finite instant", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      await harvestDailyCloses(store, [
        point(Number.NaN, "10", "11"),
        point(dayMs("2024-03-02") + 1, "20", "22"),
      ]);
      const history = await loadValueHistory(store);
      expect(history).toEqual([
        { date: "2024-03-02", valueEur: new Decimal("20"), valueUsd: new Decimal("22") },
      ]);
    });

    it("files a wall-clock evening instant under its local calendar day", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      // 2024-03-01 22:30 local — unambiguously the 1st in every timezone, the day a
      // UTC bucket could mis-roll for viewers west of UTC. Matches the blob's calendar.
      const eveningLocal = new Date(2024, 2, 1, 22, 30).getTime();
      await harvestDailyCloses(store, [point(eveningLocal, "42", "45")]);
      const history = await loadValueHistory(store);
      expect(history[0].date).toBe("2024-03-01");
    });

    it("does not overwrite a day a more recent record already refined", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      // A live record lands first for today...
      await recordDailyClose(store, { date: "2024-03-02", valueEur: new Decimal("99"), valueUsd: new Decimal("108") });
      // ...then a harvest from the 1W curve seeds an earlier day and re-states today.
      await harvestDailyCloses(store, [
        point(dayMs("2024-03-01") + 1, "10", "11"),
        point(dayMs("2024-03-02") + 1, "20", "22"),
      ]);
      const history = await loadValueHistory(store);
      // Both days present; the harvest's same-instant write wins by merge rule.
      expect(history.map((c) => c.date)).toEqual(["2024-03-01", "2024-03-02"]);
    });

    it("is a no-op for an empty curve", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      await harvestDailyCloses(store, []);
      expect(await loadValueHistory(store)).toEqual([]);
    });
  });

  describe("pruneValueHistory", () => {
    async function seed(store: TimeSeriesStore): Promise<void> {
      for (const date of ["2024-03-01", "2024-03-02", "2024-03-03", "2024-03-04"]) {
        await recordDailyClose(store, { date, valueEur: new Decimal("1"), valueUsd: new Decimal("1") });
      }
    }

    it("drops closes strictly before the cutoff day", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      await seed(store);
      await pruneValueHistory(store, "2024-03-03");
      expect((await loadValueHistory(store)).map((c) => c.date)).toEqual(["2024-03-03", "2024-03-04"]);
    });

    it("keeps everything when the cutoff predates all closes", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      await seed(store);
      await pruneValueHistory(store, "2024-01-01");
      expect(await loadValueHistory(store)).toHaveLength(4);
    });

    it("is a no-op when nothing is stored", async () => {
      const store = new TimeSeriesStore(memoryBackend());
      await pruneValueHistory(store, "2024-03-03");
      expect(await loadValueHistory(store)).toEqual([]);
    });
  });
});
