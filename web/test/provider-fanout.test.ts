import { describe, expect, it } from "vitest";
import {
  FANOUT_INSTANT_THRESHOLD,
  TIINGO_RESERVE_CREDITS,
  TWELVE_DATA_BATCH,
  isPriorityPull,
  planFanout,
  planTwelveDataSafetyNet,
  shouldWaitForReset,
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

  it("widens the TD leg when a larger per-minute batch is supplied (paid plan)", () => {
    // A paid plan raises twelveDataPerMinute; the planner is wired to it, so the
    // single TD request grows past the free-tier 8 instead of staying capped.
    const plan = planFanout({
      ...base,
      symbols: syms(40),
      twelveDataSpendable: 30,
      twelveDataBatch: 30,
    });
    expect(plan.twelveData.length).toBe(30);
  });

  it("derives the instant threshold as 2× the supplied batch", () => {
    // batch 20 ⇒ threshold 40: 40 symbols is AT the threshold ⇒ no spill on a
    // non-priority pull (the overflow waits a TD minute).
    const atThreshold = planFanout({
      ...base,
      symbols: syms(40),
      twelveDataSpendable: 20,
      twelveDataBatch: 20,
    });
    expect(atThreshold.fannedOut).toBe(false);
    // 41 symbols is ABOVE it ⇒ spill to Tiingo.
    const aboveThreshold = planFanout({
      ...base,
      symbols: syms(41),
      twelveDataSpendable: 20,
      twelveDataBatch: 20,
    });
    expect(aboveThreshold.fannedOut).toBe(true);
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

  it("engages normally and lets loadQuotes handle budget enforcement", () => {
    // Budget enforcement is structural: loadQuotes clamps via the reservation
    // system, so the safety net always plans the re-pull and trusts the fetcher
    // to respect the live budget.
    const plan = planTwelveDataSafetyNet({
      viaTiingo: true,
      unfilled: ["AAPL", "MSFT"],
      tiingoFilled: [],
    });
    expect(plan.engaged).toBe(true);
    expect(plan.twelveData).toEqual(["AAPL", "MSFT"]);
  });
});

describe("planFanout — NAV routing (unified with stocks)", () => {
  it("routes NAVs to Twelve Data first when the TD minute has room", () => {
    const plan = planFanout({
      ...base,
      kind: "auto",
      symbols: syms(2),
      navSymbols: ["FUNDA", "FUNDB"],
      twelveDataSpendable: 8,
    });
    expect(plan.navTwelveData).toEqual(["FUNDA", "FUNDB"]);
    expect(plan.navTiingo).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it("spills NAVs to Tiingo on a login pull when the TD minute is spent", () => {
    // The 1D graph backfill ate the whole TD minute (spendable 0), Tiingo is idle:
    // a top-priority login pull must let the NAVs ride Tiingo, not starve.
    const plan = planFanout({
      ...base,
      kind: "start",
      symbols: [],
      navSymbols: ["FUNDA", "FUNDB"],
      twelveDataSpendable: 0,
      tiingoSpendable: 40,
    });
    expect(plan.navTwelveData).toEqual([]);
    expect(plan.navTiingo).toEqual(["FUNDA", "FUNDB"]);
    expect(plan.deferred).toEqual([]);
  });

  it("defers a small NAV sleeve (≤ threshold) on a non-priority round, exactly like a small stock sleeve", () => {
    // Unified policy: below the instant threshold a non-priority round never spills
    // — whether the overflow is stocks or NAVs. With no TD budget these 2 NAVs wait
    // a TD minute, the same as 2 leftover stocks would.
    const plan = planFanout({
      ...base,
      kind: "auto",
      symbols: [],
      navSymbols: ["FUNDA", "FUNDB"],
      twelveDataSpendable: 0,
      tiingoSpendable: 40,
    });
    expect(plan.navTiingo).toEqual([]);
    expect(plan.deferred).toEqual(["FUNDA", "FUNDB"]);
  });

  it("spills NAVs to Tiingo on a non-priority >16 sleeve, exactly like stocks (the unification)", () => {
    // The C8 regression this fixes: a big auto round used to keep NAVs on "Twelve
    // Data only" and defer them while the market overflow fanned out. Now a NAV is
    // just another symbol in the >16 instant sleeve, so it spills to Tiingo too.
    const plan = planFanout({
      ...base,
      kind: "auto",
      symbols: syms(16),
      navSymbols: ["FUNDA", "FUNDB"],
      twelveDataSpendable: 8,
      tiingoSpendable: 40,
    });
    // 18-symbol sleeve > 16 ⇒ fan-out: 8 on TD (all market), 10 spill to Tiingo —
    // the last 8 market + both NAVs ride the parallel Tiingo leg.
    expect(plan.fannedOut).toBe(true);
    expect(plan.navTiingo).toEqual(["FUNDA", "FUNDB"]);
    expect(plan.deferred).toEqual([]);
  });

  it("clamps the NAV Tiingo spill to the live Tiingo budget", () => {
    const plan = planFanout({
      ...base,
      kind: "start",
      symbols: [],
      navSymbols: ["FUNDA", "FUNDB", "FUNDC"],
      twelveDataSpendable: 0,
      tiingoSpendable: 1,
    });
    expect(plan.navTiingo).toEqual(["FUNDA"]);
    expect(plan.deferred).toEqual(["FUNDB", "FUNDC"]);
  });
});

describe("shouldWaitForReset (reroute-vs-wait guard)", () => {
  const autoIntervalMs = 5 * 60 * 1000; // 5-minute auto refresh

  it("waits when the limit resets within double the auto interval", () => {
    const nowMs = 0;
    // Reset 9 minutes away, 2× interval = 10 minutes ⇒ wait.
    expect(
      shouldWaitForReset({ resetAtMs: 9 * 60 * 1000, nowMs, autoIntervalMs }),
    ).toBe(true);
  });

  it("reroutes (does not wait) when the reset is further than double the interval", () => {
    const nowMs = 0;
    // Reset 11 minutes away, 2× interval = 10 minutes ⇒ reroute in full.
    expect(
      shouldWaitForReset({ resetAtMs: 11 * 60 * 1000, nowMs, autoIntervalMs }),
    ).toBe(false);
  });

  it("does not wait once the reset boundary has already passed", () => {
    expect(
      shouldWaitForReset({ resetAtMs: -1, nowMs: 0, autoIntervalMs }),
    ).toBe(false);
    expect(
      shouldWaitForReset({ resetAtMs: 0, nowMs: 0, autoIntervalMs }),
    ).toBe(false);
  });

  it("treats exactly double the interval as far enough to reroute (strict <)", () => {
    expect(
      shouldWaitForReset({ resetAtMs: 2 * autoIntervalMs, nowMs: 0, autoIntervalMs }),
    ).toBe(false);
  });

  it("never waits when the interval is non-positive (no sensible window)", () => {
    expect(
      shouldWaitForReset({ resetAtMs: 60 * 1000, nowMs: 0, autoIntervalMs: 0 }),
    ).toBe(false);
  });
});
