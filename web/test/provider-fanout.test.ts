import { describe, expect, it } from "vitest";
import {
  FANOUT_INSTANT_THRESHOLD,
  TIINGO_RESERVE_CREDITS,
  TWELVE_DATA_BATCH,
  isPriorityPull,
  planFanout,
  planTwelveDataSafetyNet,
  type FanoutInputs,
} from "../src/provider-fanout";

function syms(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `S${i + 1}`);
}

const base: Omit<FanoutInputs, "symbols"> = {
  kind: "manual",
  twelveDataSpendable: 8,
  tiingoSpendable: 40,
  tiingoAvailable: true,
};

describe("planFanout — Twelve Data leg invariant (#1)", () => {
  it("never puts more than 8 symbols on the Twelve Data leg", () => {
    const plan = planFanout({ ...base, symbols: syms(20) });
    expect(plan.twelveData.length).toBeLessThanOrEqual(TWELVE_DATA_BATCH);
    expect(plan.twelveData.length).toBe(8);
  });

  it("clamps the TD leg to the live TD budget (cap #5)", () => {
    const plan = planFanout({ ...base, symbols: syms(20), twelveDataSpendable: 3 });
    expect(plan.twelveData.length).toBe(3);
  });
});

describe("planFanout — instant threshold (#2)", () => {
  it("does NOT spill to Tiingo at or below 16 symbols on a non-priority pull", () => {
    const plan = planFanout({ ...base, symbols: syms(16) });
    expect(plan.fannedOut).toBe(false);
    expect(plan.tiingo).toHaveLength(0);
    expect(plan.deferred).toHaveLength(8); // 16 - 8 wait a TD minute
  });

  it("fans out above 16 symbols", () => {
    const plan = planFanout({ ...base, symbols: syms(20) });
    expect(plan.fannedOut).toBe(true);
    expect(plan.tiingo.length).toBe(12);
    expect(plan.deferred).toHaveLength(0);
  });
});

describe("planFanout — login/start priority (#3)", () => {
  it("fans out even for a small set on login/start", () => {
    const plan = planFanout({ ...base, kind: "start", symbols: syms(10) });
    expect(plan.fannedOut).toBe(true);
    expect(plan.twelveData).toHaveLength(8);
    expect(plan.tiingo).toHaveLength(2);
  });

  it("isPriorityPull is true only for start", () => {
    expect(isPriorityPull("start")).toBe(true);
    expect(isPriorityPull("manual")).toBe(false);
    expect(isPriorityPull("auto")).toBe(false);
    expect(isPriorityPull("reset")).toBe(false);
  });
});

describe("planFanout — Tiingo reserve (#4)", () => {
  it("leaves the last 10 Tiingo credits for a non-login fan-out", () => {
    const plan = planFanout({ ...base, symbols: syms(40), tiingoSpendable: 15 });
    // usable Tiingo = 15 - 10 reserve = 5
    expect(plan.tiingo).toHaveLength(5);
  });

  it("lets login/start consume even the reserve", () => {
    const plan = planFanout({ ...base, kind: "start", symbols: syms(40), tiingoSpendable: 15 });
    expect(plan.tiingo).toHaveLength(15);
  });
});

describe("planFanout — hard caps never bypassed (#5)", () => {
  it("clamps Tiingo to the live budget and defers the rest", () => {
    const plan = planFanout({
      ...base,
      kind: "start",
      symbols: syms(30),
      twelveDataSpendable: 8,
      tiingoSpendable: 5,
    });
    expect(plan.twelveData).toHaveLength(8);
    expect(plan.tiingo).toHaveLength(5);
    expect(plan.deferred).toHaveLength(17); // 30 - 8 - 5
  });

  it("defers all overflow when Tiingo is unavailable", () => {
    const plan = planFanout({ ...base, symbols: syms(20), tiingoAvailable: false });
    expect(plan.tiingo).toHaveLength(0);
    expect(plan.deferred).toHaveLength(12);
    expect(plan.fannedOut).toBe(false);
  });

  it("the union of all legs never exceeds the input symbols and never duplicates", () => {
    const plan = planFanout({ ...base, kind: "start", symbols: syms(25), tiingoSpendable: 6 });
    const all = [...plan.twelveData, ...plan.tiingo, ...plan.deferred];
    expect(all).toHaveLength(25);
    expect(new Set(all).size).toBe(25);
  });
});

describe("planFanout — no overflow case", () => {
  it("is Twelve-Data-only when everything fits one request", () => {
    const plan = planFanout({ ...base, symbols: syms(8) });
    expect(plan.fannedOut).toBe(false);
    expect(plan.tiingo).toHaveLength(0);
    expect(plan.deferred).toHaveLength(0);
    expect(plan.reason).toContain("Twelve Data only");
  });

  it("exposes documented constants", () => {
    expect(TWELVE_DATA_BATCH).toBe(8);
    expect(FANOUT_INSTANT_THRESHOLD).toBe(16);
    expect(TIINGO_RESERVE_CREDITS).toBe(10);
  });
});

describe("planTwelveDataSafetyNet — reverse Tiingo → Twelve Data fallback", () => {
  it("stays idle when Twelve Data was the primary (not the via-Tiingo route)", () => {
    const plan = planTwelveDataSafetyNet({
      viaTiingo: false,
      unfilled: ["AAPL", "MSFT"],
      tiingoFilled: [],
    });
    expect(plan.engaged).toBe(false);
    expect(plan.twelveData).toHaveLength(0);
    expect(plan.reason).toContain("Twelve Data was the primary");
  });

  it("stays idle when the Tiingo primary covered every requested symbol", () => {
    const plan = planTwelveDataSafetyNet({
      viaTiingo: true,
      unfilled: ["AAPL", "MSFT"],
      tiingoFilled: ["AAPL", "MSFT"],
    });
    expect(plan.engaged).toBe(false);
    expect(plan.twelveData).toHaveLength(0);
    expect(plan.reason).toContain("covered every requested symbol");
  });

  it("re-pulls exactly the symbols Tiingo left unfilled", () => {
    const plan = planTwelveDataSafetyNet({
      viaTiingo: true,
      unfilled: ["AAPL", "MSFT", "GOOG"],
      tiingoFilled: ["MSFT"],
    });
    expect(plan.engaged).toBe(true);
    expect(plan.twelveData).toEqual(["AAPL", "GOOG"]);
    expect(plan.reason).toContain("re-pulling on Twelve Data");
  });

  it("re-pulls the whole sleeve when Tiingo filled nothing (total outage)", () => {
    const plan = planTwelveDataSafetyNet({
      viaTiingo: true,
      unfilled: ["AAPL", "MSFT"],
      tiingoFilled: [],
    });
    expect(plan.engaged).toBe(true);
    expect(plan.twelveData).toEqual(["AAPL", "MSFT"]);
  });

  it("never proposes a symbol Tiingo already filled (no double fetch)", () => {
    const plan = planTwelveDataSafetyNet({
      viaTiingo: true,
      unfilled: ["AAPL", "MSFT", "GOOG", "TSLA"],
      tiingoFilled: ["AAPL", "GOOG", "TSLA"],
    });
    expect(plan.twelveData).toEqual(["MSFT"]);
  });
});
