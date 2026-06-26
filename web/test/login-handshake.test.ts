import { describe, expect, it } from "vitest";
import { reconcileHandshake } from "../src/login-handshake";

describe("reconcileHandshake — two-step login dedup", () => {
  it("pulls only the stale truth symbols Step 1 did not book", () => {
    const diff = reconcileHandshake(
      { symbols: ["AAA", "BBB"], fx: true },
      { staleSymbols: ["AAA", "CCC"], fxStale: true },
    );
    // AAA was booked by Step 1 → deduped; CCC is the only new diff; FX booked.
    expect(diff.symbols).toEqual(["CCC"]);
    expect(diff.fx).toBe(false);
    expect(diff.hasWork).toBe(true);
  });

  it("surfaces a newly-bought symbol the prediction never knew", () => {
    const diff = reconcileHandshake(
      { symbols: ["AAA"], fx: true },
      { staleSymbols: ["AAA", "NEW"], fxStale: false },
    );
    expect(diff.symbols).toEqual(["NEW"]);
    expect(diff.newlyDiscovered).toEqual(["NEW"]);
    expect(diff.reason).toContain("newly-bought: NEW");
  });

  it("is a true no-op when the blob matched the prefetch (seconds-later re-login)", () => {
    const diff = reconcileHandshake(
      { symbols: ["AAA", "BBB"], fx: true },
      { staleSymbols: [], fxStale: false },
    );
    expect(diff.hasWork).toBe(false);
    expect(diff.symbols).toEqual([]);
    expect(diff.fx).toBe(false);
    expect(diff.reason).toContain("re-login no-op");
  });

  it("re-login where everything is fresh-but-known pulls nothing", () => {
    // All truth symbols are inside their freshness window ⇒ staleSymbols empty.
    const diff = reconcileHandshake(
      { symbols: ["AAA", "BBB", "CCC"], fx: true },
      { staleSymbols: [], fxStale: false },
    );
    expect(diff.hasWork).toBe(false);
  });

  it("pulls FX in Step 2 only when stale AND not already booked", () => {
    const booked = { symbols: [], fx: false };
    expect(reconcileHandshake(booked, { staleSymbols: [], fxStale: true }).fx).toBe(true);
    expect(
      reconcileHandshake({ symbols: [], fx: true }, { staleSymbols: [], fxStale: true }).fx,
    ).toBe(false);
  });

  it("dedups repeated stale symbols within the diff", () => {
    const diff = reconcileHandshake(
      { symbols: [], fx: true },
      { staleSymbols: ["X", "X", "Y"], fxStale: false },
    );
    expect(diff.symbols).toEqual(["X", "Y"]);
  });

  it("Step 2 can never re-fetch what Step 1 booked, even if all are stale", () => {
    const diff = reconcileHandshake(
      { symbols: ["A", "B", "C"], fx: true },
      { staleSymbols: ["A", "B", "C"], fxStale: true },
    );
    expect(diff.symbols).toEqual([]);
    expect(diff.fx).toBe(false);
    expect(diff.hasWork).toBe(false);
  });

  it("does not mislabel a predicted-but-stale symbol as newly-bought", () => {
    // DDD was in Step 1's predicted universe but not booked (e.g. deferred over
    // budget). It's a legit diff symbol, yet it is NOT newly-bought; only EEE,
    // absent from the prediction, is.
    const diff = reconcileHandshake(
      { symbols: ["AAA"], predicted: ["AAA", "DDD"], fx: true },
      { staleSymbols: ["DDD", "EEE"], fxStale: false },
    );
    expect(diff.symbols).toEqual(["DDD", "EEE"]);
    expect(diff.newlyDiscovered).toEqual(["EEE"]);
    expect(diff.reason).toContain("newly-bought: EEE");
    expect(diff.reason).not.toContain("DDD");
  });

  it("defaults the prediction set to the booked symbols when none is given", () => {
    // No explicit predicted set ⇒ a diff symbol the prefetch never booked counts
    // as newly-discovered (legacy behaviour preserved).
    const diff = reconcileHandshake(
      { symbols: ["AAA"], fx: true },
      { staleSymbols: ["NEW"], fxStale: false },
    );
    expect(diff.newlyDiscovered).toEqual(["NEW"]);
  });
});
