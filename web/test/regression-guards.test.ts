import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal-config";
import {
  DEFAULT_GRID_MS,
  mergeSleeveSeries,
  parseMarketSeries,
  type SleevePoint,
} from "../src/market-sleeve";
import {
  FANOUT_INSTANT_THRESHOLD,
  TIINGO_RESERVE_CREDITS,
  TWELVE_DATA_BATCH,
  planFanout,
  type FanoutKind,
} from "../src/provider-fanout";
import { reconcileHandshake } from "../src/login-handshake";
import { describePlan, planPull, type PullContext } from "../src/data-orchestrator";
import { ONE_HOUR_MS } from "../src/freshness";

/**
 * WS8 — the part-2 regression guards (`docs/centralized_data_pull_plan.md`
 * §"Workstreams" item 8 / §"Verification"). These lock the three invariants the
 * centralized pull must never regress on, expressed against the pure decision
 * modules they live in:
 *
 *  1. **1W detail-accretion is never coarsened** by the blob⇄web sleeve merge.
 *  2. **No fan-out path bypasses the budget / breaker** — every leg is clamped to
 *     the caller-supplied spendable caps, login included.
 *  3. **A re-login / interaction issues no redundant work** — the handshake dedups
 *     Step 2 against Step 1 down to a true no-op.
 */

const fx = new Decimal("1.08");
function sleeve(t: number, usd: number): SleevePoint {
  return { t, valueNativeUsd: new Decimal(usd), fxEurUsd: fx };
}

describe("WS8 guard — 1W detail-accretion is never coarsened by the merge", () => {
  it("keeps at least as many points as the richer source", () => {
    const web: SleevePoint[] = Array.from({ length: 5 }, (_, i) =>
      sleeve(i * DEFAULT_GRID_MS, 1000 + i),
    );
    // Blob is denser: two points inside the same buckets the web covers, plus an
    // extra later bucket the web never reached.
    const blob: SleevePoint[] = [
      sleeve(0, 1000),
      sleeve(DEFAULT_GRID_MS, 1001),
      sleeve(2 * DEFAULT_GRID_MS, 1002),
      sleeve(3 * DEFAULT_GRID_MS, 1003),
      sleeve(4 * DEFAULT_GRID_MS, 1004),
      sleeve(5 * DEFAULT_GRID_MS, 1005),
    ];
    const merged = mergeSleeveSeries(web, blob);
    // The merge must never shed detail: it carries at least the densest source.
    expect(merged.points.length).toBeGreaterThanOrEqual(Math.max(web.length, blob.length));
  });

  it("a blob-only later bucket strictly extends, never replaces, the web tail", () => {
    const web: SleevePoint[] = [sleeve(0, 1000), sleeve(DEFAULT_GRID_MS, 1010)];
    const blob: SleevePoint[] = [
      sleeve(0, 1000),
      sleeve(DEFAULT_GRID_MS, 1010),
      sleeve(2 * DEFAULT_GRID_MS, 1020),
    ];
    const merged = mergeSleeveSeries(web, blob);
    const lastT = merged.points[merged.points.length - 1]!.t;
    expect(lastT).toBe(2 * DEFAULT_GRID_MS);
    expect(merged.points.length).toBeGreaterThan(web.length);
  });

  it("agreeing slots are thickened (union), never thinned", () => {
    const web: SleevePoint[] = [sleeve(0, 1000), sleeve(60_000, 1000.5)];
    const blob: SleevePoint[] = [sleeve(30_000, 1000.2), sleeve(90_000, 1000.7)];
    // All four fall inside the first 30m bucket and agree within τ.
    const merged = mergeSleeveSeries(web, blob);
    expect(merged.counts.both).toBe(1);
    expect(merged.points.length).toBe(web.length + blob.length);
  });

  it("a disagreement keeps the blob and raises a flag, never spikes the line", () => {
    const web: SleevePoint[] = [sleeve(0, 2000)];
    const blob: SleevePoint[] = [sleeve(0, 1000)];
    const merged = mergeSleeveSeries(web, blob);
    expect(merged.flags).toHaveLength(1);
    // Authoritative blob value survives; the divergent web value is not blended in.
    expect(merged.points.every((p) => p.source !== "web")).toBe(true);
  });

  it("parseMarketSeries skips capture gaps without dropping good detail", () => {
    const points = parseMarketSeries({
      times: ["2024-01-01T15:00:00Z", "2024-01-01T15:30:00Z", "2024-01-01T16:00:00Z"],
      value_native: ["1000", null, "1002"],
      fx_eur_usd: ["1.08", "1.08", "1.08"],
    });
    expect(points.map((p) => p.valueNativeUsd.toNumber())).toEqual([1000, 1002]);
    expect(points).toHaveLength(2);
  });
});

describe("WS8 guard — no fan-out path bypasses budget / breaker", () => {
  const kinds: FanoutKind[] = ["start", "auto", "manual", "reset"];
  const symbols = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);

  it("the Twelve Data leg is always one request of ≤8 across every kind and budget", () => {
    for (const kind of kinds) {
      for (const td of [0, 1, 8, 50]) {
        const plan = planFanout({
          kind,
          symbols: symbols(40),
          twelveDataSpendable: td,
          tiingoSpendable: 100,
          tiingoAvailable: true,
        });
        expect(plan.twelveData.length).toBeLessThanOrEqual(TWELVE_DATA_BATCH);
        expect(plan.twelveData.length).toBeLessThanOrEqual(td);
      }
    }
  });

  it("no leg ever exceeds its spendable budget (hard cap #5)", () => {
    for (const kind of kinds) {
      const td = 5;
      const tg = 7;
      const plan = planFanout({
        kind,
        symbols: symbols(40),
        twelveDataSpendable: td,
        tiingoSpendable: tg,
        tiingoAvailable: true,
      });
      expect(plan.twelveData.length).toBeLessThanOrEqual(td);
      expect(plan.tiingo.length).toBeLessThanOrEqual(tg);
      const total = plan.twelveData.length + plan.tiingo.length + plan.deferred.length;
      expect(total).toBe(40);
    }
  });

  it("a non-login spill leaves the last 10 Tiingo credits untouched", () => {
    const plan = planFanout({
      kind: "manual",
      symbols: symbols(FANOUT_INSTANT_THRESHOLD + 20),
      twelveDataSpendable: 8,
      tiingoSpendable: 30,
      tiingoAvailable: true,
    });
    expect(plan.tiingo.length).toBeLessThanOrEqual(30 - TIINGO_RESERVE_CREDITS);
  });

  it("login/start may consume even the reserve, but never beyond the budget", () => {
    const plan = planFanout({
      kind: "start",
      symbols: symbols(40),
      twelveDataSpendable: 8,
      tiingoSpendable: 30,
      tiingoAvailable: true,
    });
    // Exempt from the reserve floor (login is top priority)…
    expect(plan.tiingo.length).toBeGreaterThan(30 - TIINGO_RESERVE_CREDITS);
    // …but still hard-clamped to the live Tiingo budget.
    expect(plan.tiingo.length).toBeLessThanOrEqual(30);
  });

  it("a frozen provider (0 spendable) defers rather than overspends", () => {
    const plan = planFanout({
      kind: "manual",
      symbols: symbols(20),
      twelveDataSpendable: 0,
      tiingoSpendable: 0,
      tiingoAvailable: true,
    });
    expect(plan.twelveData).toHaveLength(0);
    expect(plan.tiingo).toHaveLength(0);
    expect(plan.deferred).toHaveLength(20);
  });
});

describe("WS8 guard — a re-login issues no redundant work", () => {
  it("the handshake dedups Step 2 against Step 1 down to a no-op", () => {
    const booked = { symbols: ["AAA", "BBB", "CCC"], fx: true };
    const diff = reconcileHandshake(booked, { staleSymbols: ["AAA", "BBB", "CCC"], fxStale: false });
    expect(diff.hasWork).toBe(false);
    expect(diff.symbols).toHaveLength(0);
    expect(diff.fx).toBe(false);
  });

  it("only a genuinely new (newly-bought) symbol survives the dedup", () => {
    const booked = { symbols: ["AAA", "BBB"], fx: true };
    const diff = reconcileHandshake(booked, { staleSymbols: ["AAA", "BBB", "ZZZ"], fxStale: true });
    expect(diff.symbols).toEqual(["ZZZ"]);
    expect(diff.newlyDiscovered).toEqual(["ZZZ"]);
    // FX was already booked by Step 1 — never re-pulled.
    expect(diff.fx).toBe(false);
  });
});

/**
 * WS-part-2 follow-up — the orchestrator is now the *authority*, not a logger.
 * These guard the two structural gaps that were closed by wiring `app.ts` through
 * the pure decision modules:
 *
 *  4. **`planPull` owns the 1D/1W bar gate.** `app.ts::graphPrimeDecision` no
 *     longer re-implements the clock-hour gate inline — it delegates to
 *     {@link planPull} with a "bars-are-candidates" (heavily-outdated) context and
 *     reads back the bar legs. These lock that contract so the delegation keeps
 *     reproducing the previous gate exactly.
 *  5. **`planFanout` owns the login provider split** (proven by the budget guards
 *     above): the login dispatch now executes the legs the planner names rather
 *     than logging them, so the split is the decision of record.
 */
describe("WS-part-2 guard — planPull owns the bar-prime gate (graphPrimeDecision delegation)", () => {
  const sessionOpenMs = Date.UTC(2026, 5, 25, 13, 30, 0); // 09:30 ET
  // Mirror the exact context app.ts hands planPull for graph priming: bars are
  // candidates (heavily-outdated), so the only thing gating them is the overlay.
  function graphCtx(over: Partial<PullContext>): PullContext {
    return {
      kind: "auto",
      nowMs: sessionOpenMs,
      market: "open",
      minutesSinceOpenMs: 0,
      autoIntervalMs: 15 * 60 * 1000,
      freshness: { dataAgeMs: 2 * ONE_HOUR_MS, deviceDaysMissing: 2, blobDaysOld: 2, quoteAgeMs: 0, navHeldForToday: false },
      barGate: { lastBarPullMs: null, sessionOpenMs },
      ...over,
    };
  }
  const barsDue = (ctx: PullContext): boolean => {
    const plan = planPull(ctx);
    return plan.legs.dayBars || plan.legs.weekBars;
  };

  it("reset → full re-prime: bars always due", () => {
    expect(barsDue(graphCtx({ kind: "reset" }))).toBe(true);
  });

  it("market closed → bars due (the prime self-gates downstream, no clock-hour gate)", () => {
    expect(barsDue(graphCtx({ market: "closed", minutesSinceOpenMs: 0 }))).toBe(true);
  });

  it("market open, first bar < one interval into the session → held", () => {
    // 5 minutes after the open: no bar yet, breadcrumbs carry the line.
    expect(barsDue(graphCtx({ nowMs: sessionOpenMs + 5 * 60 * 1000, minutesSinceOpenMs: 5 * 60 * 1000 }))).toBe(false);
  });

  it("market open, first bar once ≥1 interval has elapsed → due", () => {
    expect(barsDue(graphCtx({ nowMs: sessionOpenMs + ONE_HOUR_MS, minutesSinceOpenMs: ONE_HOUR_MS }))).toBe(true);
  });

  it("market open, within the same clock hour as the last bar → held until the next :00", () => {
    const lastBarPullMs = Date.UTC(2026, 5, 25, 15, 30, 0);
    expect(barsDue(graphCtx({ nowMs: lastBarPullMs + 10 * 60 * 1000, barGate: { lastBarPullMs, sessionOpenMs } }))).toBe(false);
  });

  it("market open, a new clock hour after the last bar → due", () => {
    const lastBarPullMs = Date.UTC(2026, 5, 25, 15, 30, 0);
    expect(barsDue(graphCtx({ nowMs: Date.UTC(2026, 5, 25, 17, 0, 0), barGate: { lastBarPullMs, sessionOpenMs } }))).toBe(true);
  });

  it("the decision is rendered into a log-ready orchestrator line", () => {
    expect(describePlan(planPull(graphCtx({ kind: "reset" })))).toContain("reset");
  });
});
