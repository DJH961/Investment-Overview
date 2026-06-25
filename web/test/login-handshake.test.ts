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
});
