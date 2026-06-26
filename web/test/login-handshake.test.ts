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

describe("reconcileHandshake — currency-mismatch (C6)", () => {
  it("re-pulls a symbol whose decrypted currency differs from the plan's assumption", () => {
    // Step 1 primed AAA as USD; the blob reveals it is actually EUR. Even though
    // the ledger would call it fresh (not in staleSymbols), the wrong-denomination
    // quote must be corrected, so it appears in the diff and the mismatch list.
    const diff = reconcileHandshake(
      { symbols: ["AAA"], predicted: ["AAA"], fx: true },
      { staleSymbols: [], fxStale: false, currencyMismatches: ["AAA"] },
    );
    expect(diff.symbols).toEqual(["AAA"]);
    expect(diff.currencyMismatches).toEqual(["AAA"]);
    expect(diff.hasWork).toBe(true);
    expect(diff.reason).toContain("currency-mismatch: AAA");
  });

  it("does not label a currency-mismatch symbol as newly-bought", () => {
    // AAA is an existing (predicted) holding whose currency changed — a distinct
    // reason from a brand-new holding, so it must not show up under newly-bought.
    const diff = reconcileHandshake(
      { symbols: ["AAA"], predicted: ["AAA"], fx: true },
      { staleSymbols: [], fxStale: false, currencyMismatches: ["AAA"] },
    );
    expect(diff.newlyDiscovered).toEqual([]);
    expect(diff.reason).not.toContain("newly-bought");
  });

  it("produces zero mismatches for a steady-state USD-only book", () => {
    const diff = reconcileHandshake(
      { symbols: ["AAA", "BBB"], fx: true },
      { staleSymbols: [], fxStale: false, currencyMismatches: [] },
    );
    expect(diff.currencyMismatches).toEqual([]);
    expect(diff.hasWork).toBe(false);
  });

  it("does not double-list a symbol that is both stale and currency-mismatched", () => {
    const diff = reconcileHandshake(
      { symbols: [], predicted: ["AAA"], fx: true },
      { staleSymbols: ["AAA"], fxStale: false, currencyMismatches: ["AAA"] },
    );
    expect(diff.symbols).toEqual(["AAA"]);
    expect(diff.currencyMismatches).toEqual(["AAA"]);
  });
});
