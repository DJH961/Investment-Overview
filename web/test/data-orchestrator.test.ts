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

  it("turns the 1D bar ON when a clock hour is due even if the freshness tier is fresh (sole authority, both directions)", () => {
    // Quotes/FX are inside one interval (fresh tier ⇒ no quote/FX leg), but a new
    // clock hour is due and no bar has been pulled this session: the gate — not the
    // tier — owns the bar during market hours, so the 1D bar leg turns on. This is
    // the single-plan unification: one plan decides both legs and the bar gate.
    const open = Date.UTC(2026, 5, 25, 13, 30, 0);
    const now = Date.UTC(2026, 5, 25, 18, 0, 0);
    const fresh = { dataAgeMs: 5 * MIN, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 5 * MIN, navHeldForToday: true };
    const plan = planPull(ctx({ kind: "auto", nowMs: now, freshness: fresh, barGate: { lastBarPullMs: null, sessionOpenMs: open } }));
    expect(plan.tier).toBe("fresh");
    expect(plan.legs.quotes).toBe(false);
    expect(plan.legs.dayBars).toBe(true);
    expect(plan.reason).toContain("1D bar due");
  });

  it("never strips bars when heavily-outdated and no clock hour is due (history still backfills)", () => {
    // A heavily-outdated round (both device + blob >1 day behind) in a non-:00
    // window: the clock-hour gate is the 1D authority only and must NOT hold the
    // backfill — both the 1D and 1W history legs survive so a stale manual/auto
    // round still repairs the book.
    const open = Date.UTC(2026, 5, 25, 13, 30, 0);
    const now = Date.UTC(2026, 5, 25, 18, 10, 0);
    const veryStale = { dataAgeMs: 3 * 24 * ONE_HOUR_MS, deviceDaysMissing: 3, blobDaysOld: 3, quoteAgeMs: 3 * 24 * ONE_HOUR_MS, navHeldForToday: false };
    const plan = planPull(ctx({ kind: "auto", nowMs: now, freshness: veryStale, barGate: { lastBarPullMs: now - 10 * MIN, sessionOpenMs: open } }));
    expect(plan.tier).toBe("heavily-outdated");
    expect(plan.legs.dayBars).toBe(true);
    expect(plan.legs.weekBars).toBe(true);
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
    // The first login already pulled this clock hour's 1D bar, so the bar gate is
    // satisfied (next bar held until the next :00); with quotes/FX inside one
    // interval too, the seconds-later re-login is a pure no-op.
    const nowMs = Date.UTC(2026, 5, 25, 18, 0, 0);
    const plan = planPull(
      ctx({
        kind: "start",
        nowMs,
        freshness: { dataAgeMs: 5 * MIN, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 5 * MIN, navHeldForToday: true },
        barGate: { lastBarPullMs: nowMs - 5 * MIN, sessionOpenMs: Date.UTC(2026, 5, 25, 13, 30, 0) },
      }),
    );
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

describe("planPull — FX freshness overlay (Overlay 3)", () => {
  // Base: a relatively-fresh scenario where the graded tier would enable FX.
  const staleQuotes = { dataAgeMs: 30 * MIN, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 30 * MIN, navHeldForToday: true };

  it("auto suppresses FX when it was pulled within the interval", () => {
    const fxAge = 2 * MIN; // well within 15-min interval
    const freshness = { ...staleQuotes, fxAgeMs: fxAge };
    const plan = planPull(ctx({ kind: "auto", freshness }));
    expect(plan.legs.fx).toBe(false);
    expect(plan.reason).toContain("FX held");
  });

  it("manual always re-pulls FX even when it was just pulled", () => {
    const freshness = { ...staleQuotes, fxAgeMs: 30 * 1000 }; // 30 seconds old
    const plan = planPull(ctx({ kind: "manual", freshness }));
    expect(plan.legs.fx).toBe(true);
  });

  it("auto pulls FX once the interval has elapsed", () => {
    const fxAge = 20 * MIN; // beyond 15-min interval
    const freshness = { ...staleQuotes, fxAgeMs: fxAge };
    const plan = planPull(ctx({ kind: "auto", freshness }));
    expect(plan.legs.fx).toBe(true);
  });

  it("treats missing fxAgeMs (undefined) as always stale — FX is pulled", () => {
    // Fixtures without fxAgeMs: undefined defaults to Infinity → always due.
    const plan = planPull(ctx({ kind: "auto", freshness: staleQuotes }));
    expect(plan.legs.fx).toBe(true);
  });
});

describe("planPull — C1 currency-known / phase context", () => {
  it("accepts the phase + currencyKnown context as decision-neutral (gate lives upstream)", () => {
    // The currency-known gate prevents an empty quote cache being inflated into a
    // 10-day gap in buildPullFreshness (app.ts); by the time planPull runs the
    // ledger is already honest, so carrying the context must not itself change the
    // plan — a pre-decrypt, currency-unknown pass plans the same as a known one for
    // an identical freshness ledger.
    const fresh = { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true };
    const known = planPull(ctx({ kind: "auto", freshness: fresh, phase: "post-decrypt", currencyKnown: true }));
    const unknown = planPull(ctx({ kind: "auto", freshness: fresh, phase: "pre-decrypt", currencyKnown: false }));
    expect(unknown.tier).toBe(known.tier);
    expect(unknown.legs).toEqual(known.legs);
  });

  it("defaults the context fields to a known post-decrypt pass when omitted", () => {
    // Omitting the optional C1 fields must behave exactly as the explicit defaults.
    const stale = { dataAgeMs: 2 * ONE_HOUR_MS, deviceDaysMissing: 1, blobDaysOld: 0, quoteAgeMs: 2 * ONE_HOUR_MS, navHeldForToday: true };
    const implicit = planPull(ctx({ kind: "manual", market: "closed", minutesSinceOpenMs: 0, freshness: stale }));
    const explicit = planPull(ctx({ kind: "manual", market: "closed", minutesSinceOpenMs: 0, freshness: stale, phase: "post-decrypt", currencyKnown: true }));
    expect(implicit.legs).toEqual(explicit.legs);
    expect(implicit.tier).toBe(explicit.tier);
  });
});
