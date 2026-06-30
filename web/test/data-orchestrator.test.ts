import { describe, expect, it } from "vitest";
import {
  describePlan,
  deviceDaysMissing,
  planPull,
  planPullsAnything,
  type PullContext,
  type PullKind,
} from "../src/data-orchestrator";
import { ONE_HOUR_MS } from "../src/freshness";

const MIN = 60 * 1000;

function ctx(over: Partial<PullContext> = {}): PullContext {
  const nowMs = Date.UTC(2026, 5, 25, 18, 0, 0);
  return {
    kind: "auto",
    nowMs,
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
      // A bar pulled 5 min ago: inside the 30-min staleness window, so the default
      // scenario is NOT a bar round (tests that exercise the promotion set this
      // explicitly). This isolates the quote / FX overlays from the bar gate.
      lastBarPullMs: nowMs - 5 * MIN,
      sessionOpenMs: Date.UTC(2026, 5, 25, 13, 30, 0),
    },
    ...over,
  };
}

describe("planPull — reset", () => {
  it("pulls every leg regardless of freshness", () => {
    const plan = planPull(ctx({ kind: "reset", freshness: { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true } }));
    expect(plan.tier).toBe("outdated");
    expect(plan.legs.weekBars && plan.legs.dayBars && plan.legs.quotes && plan.legs.nav && plan.legs.fx).toBe(true);
    expect(plan.legs.fxBars).toBe(true);
    expect(planPullsAnything(plan)).toBe(true);
  });
});

describe("planPull — currency-KPI fxBars anchor overlay (Overlay 4)", () => {
  it("raises the fxBars leg when the KPI session anchor is missing on an otherwise-quiet tick", () => {
    const fresh = { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true };
    const quiet = planPull(ctx({ kind: "auto", freshness: { ...fresh, fxBarsAnchorMissing: false } }));
    expect(quiet.legs.fxBars).toBe(false);
    const due = planPull(ctx({ kind: "auto", freshness: { ...fresh, fxBarsAnchorMissing: true } }));
    expect(due.legs.fxBars).toBe(true);
    expect(planPullsAnything(due)).toBe(true);
  });

  it("leaves fxBars off on an auto tick when the anchor is present", () => {
    const plan = planPull(ctx({ kind: "auto", freshness: { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true, fxBarsAnchorMissing: false } }));
    expect(plan.legs.fxBars).toBe(false);
  });

  it("a manual tap re-requests the FX bars even when the anchor is already in hand (distrust the cache)", () => {
    const plan = planPull(ctx({ kind: "manual", freshness: { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true, fxBarsAnchorMissing: false } }));
    expect(plan.legs.fxBars).toBe(true);
    expect(plan.reason).toContain("FX bars re-pulled");
  });
});

describe("planPull — bar staleness overlay (sole 1D-bar authority while open, O3)", () => {
  const stale = { dataAgeMs: 2 * ONE_HOUR_MS, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 2 * ONE_HOUR_MS, navHeldForToday: true };

  it("holds bars on a non-due scheduled round, keeps quotes/FX", () => {
    // last bar pulled 10 min ago ⇒ inside the 30-min window ⇒ not due. An auto
    // round (the outdated tier lit today's session bar) drops it; breadcrumbs carry
    // the line, and the quotes/FX survive.
    const now = Date.UTC(2026, 5, 25, 18, 10, 0);
    const plan = planPull(ctx({ kind: "auto", nowMs: now, freshness: stale, barGate: { lastBarPullMs: now - 10 * MIN, sessionOpenMs: Date.UTC(2026, 5, 25, 13, 30, 0) } }));
    expect(plan.legs.dayBars).toBe(false);
    expect(plan.legs.weekBars).toBe(false);
    expect(plan.legs.barsWindowSessions).toBe(0);
    expect(plan.legs.quotes).toBe(true);
    expect(plan.reason).toContain("30-min staleness");
  });

  it("promotes the bar AND suppresses quotes once due on a scheduled round (bar subsumes the quote)", () => {
    // A bar older than 30 min on an auto round: the bar is promoted and the round's
    // quotes are suppressed — one bar pass, not bars + ~25 quotes.
    const open = Date.UTC(2026, 5, 25, 13, 30, 0);
    const now = Date.UTC(2026, 5, 25, 18, 0, 0);
    const plan = planPull(ctx({ kind: "auto", nowMs: now, freshness: stale, barGate: { lastBarPullMs: open, sessionOpenMs: open } }));
    expect(plan.legs.dayBars).toBe(true);
    expect(plan.legs.barsWindowSessions).toBe(1);
    expect(plan.legs.quotes).toBe(false);
    expect(plan.reason).toContain("quotes suppressed");
  });

  it("a manual tap never promotes a fresh bar (the global manual button is a quote round)", () => {
    // Manual tap, bar 10 min old (not due): no promotion either way, and the
    // outdated tier's session bar is dropped — the tap stays a pure quote round.
    const now = Date.UTC(2026, 5, 25, 18, 10, 0);
    const plan = planPull(ctx({ kind: "manual", nowMs: now, freshness: stale, barGate: { lastBarPullMs: now - 10 * MIN, sessionOpenMs: Date.UTC(2026, 5, 25, 13, 30, 0) } }));
    expect(plan.legs.dayBars).toBe(false);
    expect(plan.legs.quotes).toBe(true);
  });

  it("does not gate bars when the market is closed (missing close still backfills)", () => {
    const plan = planPull(ctx({ kind: "manual", market: "closed", minutesSinceOpenMs: 0, freshness: stale }));
    expect(plan.legs.dayBars).toBe(true);
  });

  it("turns the 1D bar ON when stale even if the freshness tier is fresh (sole authority, both directions)", () => {
    // Quotes/FX are inside one interval (fresh tier ⇒ no quote/FX leg), but no bar
    // has been pulled this session and the warm-up has elapsed: the gate — not the
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

  it("never strips a heavy history window when no bar is due (history still backfills)", () => {
    // A heavy-gap round (both device + blob >1 day behind) inside the 30-min
    // window: the staleness gate is the 1D authority only and must NOT hold the
    // multi-session history backfill — both the 1D and 1W history legs survive, and
    // the heavy round keeps its quotes (no bar-subsumes-quote suppression).
    const open = Date.UTC(2026, 5, 25, 13, 30, 0);
    const now = Date.UTC(2026, 5, 25, 18, 10, 0);
    const veryStale = { dataAgeMs: 3 * 24 * ONE_HOUR_MS, deviceDaysMissing: 3, blobDaysOld: 3, quoteAgeMs: 3 * 24 * ONE_HOUR_MS, navHeldForToday: false };
    const plan = planPull(ctx({ kind: "auto", nowMs: now, freshness: veryStale, barGate: { lastBarPullMs: now - 10 * MIN, sessionOpenMs: open } }));
    expect(plan.tier).toBe("outdated");
    expect(plan.legs.dayBars).toBe(true);
    expect(plan.legs.weekBars).toBe(true);
    expect(plan.legs.quotes).toBe(true);
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

describe("planPull — manual relevance (freshness never filters a tap)", () => {
  const fresh = { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true };

  it("forces market-symbol quotes on a manual tap while open, even on the fresh tier", () => {
    // A fully-fresh book while the market is open: an auto tick pulls nothing, but
    // a manual tap is relevance-driven — the user asked, so quotes are re-pulled.
    const auto = planPull(ctx({ kind: "auto", market: "open", freshness: fresh }));
    expect(auto.legs.quotes).toBe(false);
    const manual = planPull(ctx({ kind: "manual", market: "open", freshness: fresh }));
    expect(manual.tier).toBe("fresh");
    expect(manual.legs.quotes).toBe(true);
    expect(manual.legs.nav).toBe(false);
    expect(manual.reason).toContain("quotes forced (manual: market open)");
  });

  it("pulls NAVs only on a manual tap post-close while the NAV is still awaited", () => {
    const awaited = { ...fresh, navHeldForToday: false };
    const manual = planPull(ctx({ kind: "manual", market: "closed", minutesSinceOpenMs: 0, freshness: awaited }));
    expect(manual.legs.nav).toBe(true);
    // Market symbols hold the settled close post-bell, so the tap stays NAV-only.
    expect(manual.legs.quotes).toBe(false);
  });

  it("re-verifies all symbols on a manual tap once closed with the NAV in hand", () => {
    const manual = planPull(ctx({ kind: "manual", market: "closed", minutesSinceOpenMs: 0, freshness: fresh }));
    expect(manual.legs.quotes).toBe(true);
    expect(manual.legs.nav).toBe(true);
    expect(manual.reason).toContain("all symbols");
  });
});

describe("planPull — auto NAV folds into the standard cadence after the close", () => {
  it("leaves the NAV leg off on an otherwise-fresh auto tick the instant the close leaves the NAV awaited", () => {
    // Fresh quote book, market closed, today's NAV not yet published: an auto tick
    // is NOT special-cased — the NAV is refreshed on the normal graded cadence
    // (once the data ages past one interval), like every other symbol, rather than
    // chased every round.
    const fresh = { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: false };
    const plan = planPull(ctx({ kind: "auto", market: "closed", minutesSinceOpenMs: 0, freshness: fresh }));
    expect(plan.tier).toBe("fresh");
    expect(plan.legs.nav).toBe(false);
  });

  it("raises the NAV leg once the data ages past one interval while the NAV is still awaited", () => {
    // Closed, NAV awaited, data older than one interval but under an hour:
    // relatively-fresh closed branch pulls the NAV (and FX) on cadence.
    const stale = { dataAgeMs: 30 * MIN, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 30 * MIN, navHeldForToday: false };
    const plan = planPull(ctx({ kind: "auto", market: "closed", minutesSinceOpenMs: 0, freshness: stale }));
    expect(plan.tier).toBe("relatively-fresh");
    expect(plan.legs.nav).toBe(true);
  });

  it("keeps chasing the awaited NAV on cadence past the one-hour mark", () => {
    // Closed, NAV awaited, data over an hour stale: the >1h outdated-light tier
    // still pulls the NAV so a late-publishing fund keeps being attempted all
    // evening instead of being dropped after the first hour.
    const stale = { dataAgeMs: 2 * ONE_HOUR_MS, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 2 * ONE_HOUR_MS, navHeldForToday: false };
    const plan = planPull(ctx({ kind: "auto", market: "closed", minutesSinceOpenMs: 0, freshness: stale }));
    expect(plan.tier).toBe("outdated");
    expect(plan.legs.nav).toBe(true);
  });

  it("leaves the NAV leg off once today's NAV is held", () => {
    const fresh = { dataAgeMs: 2 * ONE_HOUR_MS, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 2 * ONE_HOUR_MS, navHeldForToday: true };
    const plan = planPull(ctx({ kind: "auto", market: "closed", minutesSinceOpenMs: 0, freshness: fresh }));
    expect(plan.legs.nav).toBe(false);
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

  it("manual forces the FX spot on even when the graded tier left it off (fully-fresh book)", () => {
    // A within-interval "fresh" book: the graded tier alone would pull nothing, so
    // the FX leg starts off. A manual tap distrusts the cache and re-pulls it
    // anyway — the spot sibling of the holdings' quote re-pull.
    const fresh = { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true, fxAgeMs: 30 * 1000 };
    const auto = planPull(ctx({ kind: "auto", freshness: fresh }));
    expect(auto.legs.fx).toBe(false);
    const manual = planPull(ctx({ kind: "manual", freshness: fresh }));
    expect(manual.legs.fx).toBe(true);
    expect(manual.reason).toContain("FX re-pulled");
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

describe("deviceDaysMissing — the shared market-gap gate (C1)", () => {
  it("inflates a known-currency missing market quote to the heaviest gap", () => {
    expect(deviceDaysMissing({ anyMarketMissing: true, marketStale: false, dataAgeMs: 0 })).toBe(10);
  });

  it("does NOT inflate when no market quote is known-missing (the currency-unknown start state)", () => {
    // The caller (buildPrefetchFreshness) only sets anyMarketMissing when the
    // currency is known, so a first-ever / legacy-plan login lands here: an empty
    // quote cache is the unknown-start state, never a faked 10-day re-pull.
    expect(deviceDaysMissing({ anyMarketMissing: false, marketStale: false, dataAgeMs: Number.POSITIVE_INFINITY })).toBe(0);
  });

  it("grades a stale settled close as 1 day, or 2 once the freshest mark is itself >26h old", () => {
    expect(deviceDaysMissing({ anyMarketMissing: false, marketStale: true, dataAgeMs: 2 * ONE_HOUR_MS })).toBe(1);
    expect(deviceDaysMissing({ anyMarketMissing: false, marketStale: true, dataAgeMs: 27 * ONE_HOUR_MS })).toBe(2);
  });

  it("reports a fully-current book as no days missing", () => {
    expect(deviceDaysMissing({ anyMarketMissing: false, marketStale: false, dataAgeMs: 5 * 60 * 1000 })).toBe(0);
  });
});

