/**
 * Tests for the live 1W curve orchestration (`week.ts`, Phase 4). Network and
 * persistence are injected, so no DOM / IndexedDB / live API is hit. `now` is
 * pinned to known NYSE sessions so the trading-day window is deterministic. The
 * chosen week (Mon 2026-03-09 → Fri 2026-03-13) is clear of any market holiday.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import { buildIntradayAnchor, type AnchorHoldingInput } from "../src/intraday";
import {
  DEFAULT_WEEK_SESSIONS,
  WEEK_STORE_KEY,
  loadOrBuildWeekCurve,
} from "../src/week";
import type { Bar } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";

const d = (v: string | number): Decimal => new Decimal(v);
const bar = (t: number, value: string): Bar => ({ t, value: new Decimal(value) });
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

function holding(over: Partial<AnchorHoldingInput> = {}): AnchorHoldingInput {
  return {
    priceSymbol: "VTI",
    nativeCurrency: "USD",
    priceType: "market",
    shares: d(10),
    priceNative: d(100),
    valueEur: d(900),
    valueUsd: d(1000),
    ...over,
  };
}

function store(): TimeSeriesStore {
  return new TimeSeriesStore(memoryBackend());
}

// Sat 2026-03-14 12:00 ET → market closed; the window ends on Friday's session
// (2026-03-13). Window of 5 sessions: Mon 03-09 → Fri 03-13.
const SAT_CLOSED = new Date("2026-03-14T16:00:00Z");
// Thu 2026-03-12 14:00 ET (18:00Z, EDT) → market open mid-session.
const THU_OPEN = new Date("2026-03-12T18:00:00Z");

describe("loadOrBuildWeekCurve", () => {
  it("spans DEFAULT_WEEK_SESSIONS trading days ending on the last session", async () => {
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    const dailyBars = new Map<string, Bar[]>([
      [
        "VTI",
        [
          bar(dayMs("2026-03-11"), "98"),
          bar(dayMs("2026-03-12"), "99"),
          bar(dayMs("2026-03-13"), "100"),
        ],
      ],
    ]);
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: store(),
      fetchDailyBars: async () => dailyBars,
      now: SAT_CLOSED,
    });
    expect(curve.startDay).toBe("2026-03-09");
    expect(curve.endDay).toBe("2026-03-13");
    expect(curve.marketOpen).toBe(false);
    // One point per distinct daily-close instant; ends on the headline total.
    expect(curve.points).toHaveLength(3);
    expect(curve.points[curve.points.length - 1].valueUsd.toString()).toBe("1000");
  });

  it("persists the backfilled closes under the namespaced 1W key", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map([["VTI", [bar(dayMs("2026-03-13"), "100")]]]),
      now: SAT_CLOSED,
    });
    const days = await s.listDays();
    expect(days).toContain(WEEK_STORE_KEY);
    expect(days.every((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day))).toBe(true);
  });

  it("does not re-fetch when the cache already covers the latest settled session", async () => {
    const s = store();
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-12"), "99"), bar(dayMs("2026-03-13"), "100")] },
      fx: [],
      updatedAt: 0,
    });
    let fetched = false;
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map();
      },
      now: SAT_CLOSED,
    });
    expect(fetched).toBe(false);
  });

  it("back-fills a missing FX track without re-buying daily bars (secondary currency diverges)", async () => {
    const s = store();
    // Daily closes already cover the settled window but the per-day FX track is
    // missing — the self-fetched state where the rebased EUR line collapses onto
    // USD. Market closed: the daily bars must NOT be re-fetched, only the FX.
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-12"), "99"), bar(dayMs("2026-03-13"), "100")] },
      fx: [],
      updatedAt: 0,
    });
    let barsFetched = false;
    let fxCalls = 0;
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        barsFetched = true;
        return new Map();
      },
      fetchFx: async () => {
        fxCalls += 1;
        return [bar(dayMs("2026-03-12"), "1.0"), bar(dayMs("2026-03-13"), "1.0")];
      },
      now: SAT_CLOSED,
    });
    expect(barsFetched).toBe(false);
    expect(fxCalls).toBe(1);
    // EUR rebased to the per-day rate (1.0) rather than the settled baseFx (0.9):
    // at close (ratio 1) contrib = 900 · 0.9 / 1.0 = 810 (≠ the 900 it would be
    // without an FX track), so EUR and USD genuinely diverge.
    const last = curve.points[curve.points.length - 1];
    expect(last.valueEur.toString()).toBe("810");
    expect(last.valueUsd.toString()).toBe("1000");
    // Persisted, so a later build does not re-fire the refill.
    expect((await s.loadSession(WEEK_STORE_KEY))?.fx.length).toBeGreaterThan(0);
  });

  it("does not re-fire the FX refill when the track is already in hand (no autofire)", async () => {
    const s = store();
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-12"), "99"), bar(dayMs("2026-03-13"), "100")] },
      fx: [bar(dayMs("2026-03-13"), "1.0")],
      updatedAt: 0,
    });
    let barsFetched = false;
    let fxCalled = false;
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        barsFetched = true;
        return new Map();
      },
      fetchFx: async () => {
        fxCalled = true;
        return [];
      },
      now: SAT_CLOSED,
    });
    expect(barsFetched).toBe(false);
    expect(fxCalled).toBe(false);
  });

  it("re-fetches when a new session has settled since the last backfill", async () => {
    const s = store();
    // Cache only reaches Thursday; Friday has since settled (Saturday view).
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-12"), "99")] },
      fx: [],
      updatedAt: 0,
    });
    let fetched = false;
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map([["VTI", [bar(dayMs("2026-03-13"), "100")]]]);
      },
      now: SAT_CLOSED,
    });
    expect(fetched).toBe(true);
  });

  it("does not require today's close while the market is open (tip carries today)", async () => {
    const s = store();
    // Cache reaches Wednesday; Thursday is the open session → Wednesday is the
    // latest settled day, so no re-fetch is needed.
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-11"), "98")] },
      fx: [],
      updatedAt: 0,
    });
    let fetched = false;
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map();
      },
      now: THU_OPEN,
      liveTip: { valueEur: d(950), valueUsd: d(1050) },
    });
    expect(fetched).toBe(false);
    expect(curve.marketOpen).toBe(true);
    // The live tip is the final point, newer than the last daily close.
    const last = curve.points[curve.points.length - 1];
    expect(last.valueUsd.toString()).toBe("1050");
    expect(last.t).toBe(THU_OPEN.getTime());
  });

  it("trims daily bars that have rolled out of the window", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    // A stale bar from before the window plus in-window closes.
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: {
        VTI: [
          bar(dayMs("2026-03-01"), "90"), // before the Mon 03-09 window start
          bar(dayMs("2026-03-12"), "99"),
          bar(dayMs("2026-03-13"), "100"),
        ],
      },
      fx: [],
      updatedAt: 0,
    });
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      now: SAT_CLOSED,
    });
    const reloaded = await s.loadSession(WEEK_STORE_KEY);
    const instants = (reloaded?.bars.VTI ?? []).map((b) => b.t);
    expect(instants).not.toContain(dayMs("2026-03-01"));
    expect(instants).toContain(dayMs("2026-03-13"));
  });

  it("splices today's cached 1D intraday bars into the week curve for finer detail", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    // Week cache: coarse daily closes through Wednesday (settled while open).
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: {
        VTI: [bar(dayMs("2026-03-10"), "100"), bar(dayMs("2026-03-11"), "100")],
      },
      fx: [],
      updatedAt: 0,
    });
    // 1D session cache for today (Thu) holds fine intraday bars.
    await s.saveSession({
      day: "2026-03-12",
      bars: {
        VTI: [
          bar(Date.parse("2026-03-12T14:00:00Z"), "100"),
          bar(Date.parse("2026-03-12T17:00:00Z"), "110"),
        ],
      },
      fx: [],
      updatedAt: 0,
    });
    let fetched = false;
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map();
      },
      now: THU_OPEN,
    });
    // Pure cache read — never hits the network ("if 1D was already loaded").
    expect(fetched).toBe(false);
    const instants = curve.points.map((p) => p.t);
    expect(instants).toContain(Date.parse("2026-03-12T14:00:00Z"));
    expect(instants).toContain(Date.parse("2026-03-12T17:00:00Z"));
    // The 110 intraday print lifts USD above the flat 100 daily closes.
    const lifted = curve.points.find((p) => p.t === Date.parse("2026-03-12T17:00:00Z"));
    expect(Number(lifted?.valueUsd.toString())).toBeGreaterThan(1000);
  });

  it("splices a previous day's cached 1D intraday bars (not just today)", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    // Settled week (Saturday view): coarse daily closes Wed→Fri, all flat 100.
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: {
        VTI: [
          bar(dayMs("2026-03-11"), "100"),
          bar(dayMs("2026-03-12"), "100"),
          bar(dayMs("2026-03-13"), "100"),
        ],
      },
      fx: [],
      updatedAt: 0,
    });
    // 1D session cache for Wednesday (a *previous* day) holds fine intraday bars.
    await s.saveSession({
      day: "2026-03-11",
      bars: {
        VTI: [
          bar(Date.parse("2026-03-11T14:00:00Z"), "100"),
          bar(Date.parse("2026-03-11T17:00:00Z"), "110"),
        ],
      },
      fx: [],
      updatedAt: 0,
    });
    let fetched = false;
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map();
      },
      now: SAT_CLOSED,
    });
    // Pure cache read — never hits the network.
    expect(fetched).toBe(false);
    const instants = curve.points.map((p) => p.t);
    expect(instants).toContain(Date.parse("2026-03-11T14:00:00Z"));
    expect(instants).toContain(Date.parse("2026-03-11T17:00:00Z"));
    // Wednesday's lone coarse close is replaced by its fine bars.
    expect(instants).not.toContain(dayMs("2026-03-11"));
    // The 110 intraday print lifts USD above the flat 100 daily closes.
    const lifted = curve.points.find((p) => p.t === Date.parse("2026-03-11T17:00:00Z"));
    expect(Number(lifted?.valueUsd.toString())).toBeGreaterThan(1000);
  });

  it("splices a previous day's breadcrumb trail into the otherwise-flat coarse gap", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: {
        VTI: [
          bar(dayMs("2026-03-11"), "100"),
          bar(dayMs("2026-03-12"), "100"),
          bar(dayMs("2026-03-13"), "100"),
        ],
      },
      fx: [],
      updatedAt: 0,
    });
    // Wednesday's 1D session has NO fine bars, only live-tip breadcrumbs the
    // dashboard laid while watching that day — the curve should still thicken.
    await s.saveSession({
      day: "2026-03-11",
      bars: {},
      fx: [],
      tips: [
        { t: Date.parse("2026-03-11T14:00:00Z"), valueEur: d(945), valueUsd: d(1050), baseEur: d(0), baseUsd: d(0) },
        { t: Date.parse("2026-03-11T17:00:00Z"), valueEur: d(990), valueUsd: d(1100), baseEur: d(0), baseUsd: d(0) },
      ],
      updatedAt: 0,
    });
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      now: SAT_CLOSED,
    });
    const byT = new Map(curve.points.map((p) => [p.t, p]));
    // Both breadcrumbs are spliced after Wednesday's lone (UTC-midnight) close.
    expect(byT.has(Date.parse("2026-03-11T14:00:00Z"))).toBe(true);
    expect(byT.get(Date.parse("2026-03-11T17:00:00Z"))?.valueUsd.toString()).toBe("1100");
    // Curve stays ascending after the splice.
    const times = curve.points.map((p) => p.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("rebases spliced breadcrumbs onto the current base", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-13"), "100")] },
      fx: [],
      updatedAt: 0,
    });
    // Crumb struck against a base of 50 (USD): rebased onto the current base of 0
    // it shifts down by 50 → 1100 - 50 + 0 = 1050.
    await s.saveSession({
      day: "2026-03-11",
      bars: {},
      fx: [],
      tips: [
        { t: Date.parse("2026-03-11T17:00:00Z"), valueEur: d(990), valueUsd: d(1100), baseEur: d(40), baseUsd: d(50) },
      ],
      updatedAt: 0,
    });
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      now: SAT_CLOSED,
    });
    const crumb = curve.points.find((p) => p.t === Date.parse("2026-03-11T17:00:00Z"));
    expect(crumb?.valueUsd.toString()).toBe("1050");
    expect(crumb?.valueEur.toString()).toBe("950");
  });

  it("keeps a day's real bars ground truth: drops crumbs before its last bar, keeps after", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-11"), "100"), bar(dayMs("2026-03-13"), "100")] },
      fx: [],
      updatedAt: 0,
    });
    // Wednesday has fine bars through 15:00 plus a stray crumb at 14:30 (covered
    // by the bars) and one at 16:00 (past the last bar, filling the tail gap).
    await s.saveSession({
      day: "2026-03-11",
      bars: {
        VTI: [
          bar(Date.parse("2026-03-11T14:00:00Z"), "100"),
          bar(Date.parse("2026-03-11T15:00:00Z"), "100"),
        ],
      },
      fx: [],
      tips: [
        { t: Date.parse("2026-03-11T14:30:00Z"), valueEur: d(900), valueUsd: d(1000), baseEur: d(0), baseUsd: d(0) },
        { t: Date.parse("2026-03-11T16:00:00Z"), valueEur: d(990), valueUsd: d(1100), baseEur: d(0), baseUsd: d(0) },
      ],
      updatedAt: 0,
    });
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      now: SAT_CLOSED,
    });
    const instants = curve.points.map((p) => p.t);
    // The crumb inside the bar span is dropped (bars are ground truth)…
    expect(instants).not.toContain(Date.parse("2026-03-11T14:30:00Z"));
    // …the crumb past the last bar is kept (fills the tail gap to the next day).
    expect(instants).toContain(Date.parse("2026-03-11T16:00:00Z"));
  });

  it("returns an empty curve when the anchor has no intraday holdings", async () => {
    const anchor = buildIntradayAnchor(
      [holding({ priceType: "nav" })], // folds into the base, no sleeve
      d(0),
      d(0),
      d("0.9"),
    );
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: store(),
      fetchDailyBars: async () => new Map(),
      now: SAT_CLOSED,
    });
    expect(curve.points).toEqual([]);
  });

  it("re-marks the EUR pivot at each day's FX so EUR and USD diverge", async () => {
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    const dailyBars = new Map<string, Bar[]>([
      ["VTI", [bar(dayMs("2026-03-12"), "100"), bar(dayMs("2026-03-13"), "100")]],
    ]);
    const fxBars = [
      bar(dayMs("2026-03-12"), "0.9"), // settled rate → EUR unchanged
      bar(dayMs("2026-03-13"), "1.0"), // stronger EUR → fewer EUR for same USD
    ];
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: store(),
      fetchDailyBars: async () => dailyBars,
      fetchFx: async () => fxBars,
      now: SAT_CLOSED,
    });
    const [first, second] = curve.points;
    // USD is FX-free → flat across the two equal closes.
    expect(first.valueUsd.toString()).toBe(second.valueUsd.toString());
    // EUR re-marks at the day's rate → the two genuinely differ.
    expect(first.valueEur.toString()).not.toBe(second.valueEur.toString());
  });

  it("survives an FX fetch failure, falling back to the price curve", async () => {
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: store(),
      fetchDailyBars: async () => new Map([["VTI", [bar(dayMs("2026-03-13"), "100")]]]),
      fetchFx: async () => {
        throw new Error("fx down");
      },
      now: SAT_CLOSED,
    });
    expect(curve.points).toHaveLength(1);
    expect(curve.points[0].valueUsd.toString()).toBe("1000");
  });
});

describe("week constants", () => {
  it("defaults to a five-session window", () => {
    expect(DEFAULT_WEEK_SESSIONS).toBe(5);
  });
});
