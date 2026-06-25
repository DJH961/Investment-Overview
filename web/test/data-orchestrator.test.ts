import { describe, expect, it } from "vitest";
import {
  describePlan,
  planPull,
  planPullsAnything,
  type PullContext,
  type PullKind,
} from "../src/data-orchestrator";
import { ONE_HOUR_MS } from "../src/freshness";

const MIN = 60 * 1000;

function ctx(over: Partial<PullContext> = {}): PullContext {
  return {
    kind: "auto",
    nowMs: Date.UTC(2026, 5, 25, 18, 0, 0),
    market: "open",
    minutesSinceOpenMs: 4 * ONE_HOUR_MS,
    autoIntervalMs: 15 * MIN,
    freshness: {
      dataAgeMs: 0,
      deviceDaysMissing: 0,
      blobDaysOld: 0,
      quoteAgeMs: 0,
      navHeldForToday: true,
    },
    barGate: {
      lastBarPullMs: null,
      sessionOpenMs: Date.UTC(2026, 5, 25, 13, 30, 0),
    },
    ...over,
  };
}

describe("planPull — reset", () => {
  it("pulls every leg regardless of freshness", () => {
    const plan = planPull(ctx({ kind: "reset", freshness: { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true } }));
    expect(plan.tier).toBe("heavily-outdated");
    expect(plan.legs.weekBars && plan.legs.dayBars && plan.legs.quotes && plan.legs.nav && plan.legs.fx).toBe(true);
    expect(planPullsAnything(plan)).toBe(true);
  });
});

describe("planPull — bar clock-hour overlay (sole 1D-bar authority while open)", () => {
  const stale = { dataAgeMs: 2 * ONE_HOUR_MS, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 2 * ONE_HOUR_MS, navHeldForToday: true };

  it("suppresses bars when no bar is due this hour, keeps quotes/FX", () => {
    // last bar pulled 10 min ago ⇒ not due until the next :00 after +1h.
    const now = Date.UTC(2026, 5, 25, 18, 10, 0);
    const plan = planPull(ctx({ kind: "manual", nowMs: now, freshness: stale, barGate: { lastBarPullMs: now - 10 * MIN, sessionOpenMs: Date.UTC(2026, 5, 25, 13, 30, 0) } }));
    expect(plan.legs.dayBars).toBe(false);
    expect(plan.legs.weekBars).toBe(false);
    expect(plan.legs.quotes).toBe(true);
    expect(plan.reason).toContain("clock-hour gate");
  });

  it("lets bars through once due", () => {
    const open = Date.UTC(2026, 5, 25, 13, 30, 0);
    const now = Date.UTC(2026, 5, 25, 18, 0, 0);
    const plan = planPull(ctx({ kind: "manual", nowMs: now, freshness: stale, barGate: { lastBarPullMs: open, sessionOpenMs: open } }));
    expect(plan.legs.dayBars).toBe(true);
  });

  it("does not gate bars when the market is closed (missing close still backfills)", () => {
    const plan = planPull(ctx({ kind: "manual", market: "closed", minutesSinceOpenMs: 0, freshness: stale }));
    expect(plan.legs.dayBars).toBe(true);
  });
});

describe("planPull — rolling quote TTL overlay", () => {
  const relFresh = { dataAgeMs: 30 * MIN, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 2 * MIN, navHeldForToday: true };

  it("auto suppresses a within-TTL quote re-pull", () => {
    const plan = planPull(ctx({ kind: "auto", freshness: relFresh }));
    expect(plan.legs.quotes).toBe(false);
    expect(plan.reason).toContain("rolling TTL");
  });

  it("manual always re-pulls quotes even within the TTL", () => {
    const plan = planPull(ctx({ kind: "manual", freshness: relFresh }));
    expect(plan.legs.quotes).toBe(true);
  });

  it("auto pulls the quote once the rolling window elapsed", () => {
    const plan = planPull(ctx({ kind: "auto", freshness: { ...relFresh, quoteAgeMs: 20 * MIN } }));
    expect(plan.legs.quotes).toBe(true);
  });
});

describe("planPull — fresh tick is a no-op", () => {
  it("a seconds-later re-login (data younger than one interval) pulls nothing", () => {
    const plan = planPull(ctx({ kind: "start", freshness: { dataAgeMs: 5 * MIN, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 5 * MIN, navHeldForToday: true } }));
    expect(plan.tier).toBe("fresh");
    expect(planPullsAnything(plan)).toBe(false);
  });
});

describe("describePlan", () => {
  it("renders a readable one-liner naming the mechanism and legs", () => {
    const plan = planPull(ctx({ kind: "start", freshness: { dataAgeMs: 30 * MIN, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 30 * MIN, navHeldForToday: true } }));
    const line = describePlan(plan);
    expect(line.startsWith("start →")).toBe(true);
    expect(line).toContain("quotes");
  });

  it("covers every PullKind", () => {
    const kinds: PullKind[] = ["start", "auto", "manual", "reset"];
    for (const kind of kinds) {
      const plan = planPull(ctx({ kind }));
      expect(describePlan(plan).startsWith(`${kind} →`)).toBe(true);
    }
  });
});
