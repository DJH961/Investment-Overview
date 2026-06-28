/**
 * Tests for the core-vs-bonus data registry and the reloadability contract
 * (`data-registry.ts`), plus the drift guards that keep its key literals in step
 * with the real store-key constants and its enumeration complete.
 */
import { describe, expect, it } from "vitest";

import {
  DEVICE_STORES,
  WEEK_STORE_KEY_LITERAL,
  VALUE_HISTORY_STORE_KEY_LITERAL,
  bonusStores,
  coreStores,
  storeSpec,
  summarizeClear,
  timeSeriesStoreBucket,
  timeSeriesStoreId,
} from "../src/data-registry";
import { WEEK_STORE_KEY } from "../src/week";
import { VALUE_HISTORY_STORE_KEY } from "../src/value-history";

describe("data-registry", () => {
  it("pins its key literals to the real store-key constants (drift guard)", () => {
    // The registry holds bare literals to avoid an import cycle; if either source
    // constant changes, this fails so the literal is updated in lock-step.
    expect(WEEK_STORE_KEY_LITERAL).toBe(WEEK_STORE_KEY);
    expect(VALUE_HISTORY_STORE_KEY_LITERAL).toBe(VALUE_HISTORY_STORE_KEY);
  });

  it("enumerates exactly the plan's core and bonus stores", () => {
    expect(coreStores().map((s) => s.id).sort()).toEqual(
      ["fx", "prices", "session-1d", "value-history", "week-1w"].sort(),
    );
    expect(bonusStores().map((s) => s.id).sort()).toEqual(["breadcrumbs", "polling-log"].sort());
  });

  it("requires every core store to declare a reload path", () => {
    for (const s of coreStores()) {
      expect(s.reloadPath, `core store ${s.id} must declare a reload path`).not.toBe("");
    }
  });

  it("leaves every bonus store without a reload path (lost by design)", () => {
    for (const s of bonusStores()) {
      expect(s.reloadPath).toBe("");
    }
  });

  it("classifies every store into exactly one bucket", () => {
    for (const s of DEVICE_STORES) {
      expect(["core", "bonus"]).toContain(s.bucket);
    }
    // No duplicate ids.
    const ids = DEVICE_STORES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("timeSeriesStore classification", () => {
    it("maps dated session keys to the core 1D bars", () => {
      expect(timeSeriesStoreId("2024-03-01")).toBe("session-1d");
      expect(timeSeriesStoreBucket("2024-03-01")).toBe("core");
    });

    it("maps the 1W and value-history namespaced keys to their core stores", () => {
      expect(timeSeriesStoreId(WEEK_STORE_KEY)).toBe("week-1w");
      expect(timeSeriesStoreId(VALUE_HISTORY_STORE_KEY)).toBe("value-history");
      expect(timeSeriesStoreBucket(WEEK_STORE_KEY)).toBe("core");
      expect(timeSeriesStoreBucket(VALUE_HISTORY_STORE_KEY)).toBe("core");
    });

    it("returns null for an unregistered key", () => {
      expect(timeSeriesStoreId("some-future-store")).toBeNull();
      expect(timeSeriesStoreBucket("some-future-store")).toBeNull();
    });
  });

  describe("summarizeClear", () => {
    it("groups cleared keys by bucket and flags unregistered ones", () => {
      const summary = summarizeClear([
        "2024-03-01",
        WEEK_STORE_KEY,
        VALUE_HISTORY_STORE_KEY,
        "mystery-store",
      ]);
      expect(summary.core.sort()).toEqual(
        ["2024-03-01", VALUE_HISTORY_STORE_KEY, WEEK_STORE_KEY].sort(),
      );
      expect(summary.bonus).toEqual([]);
      expect(summary.unregistered).toEqual(["mystery-store"]);
    });

    it("is empty for no keys", () => {
      expect(summarizeClear([])).toEqual({ core: [], bonus: [], unregistered: [] });
    });
  });

  it("exposes storeSpec lookup by id", () => {
    expect(storeSpec("value-history")?.bucket).toBe("core");
    expect(storeSpec("breadcrumbs")?.bucket).toBe("bonus");
    expect(storeSpec("nope")).toBeUndefined();
  });
});
