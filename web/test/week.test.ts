/**
 * Tests for the live 1W curve orchestration (`week.ts`, Phase 4). Network and
 * persistence are injected, so no DOM / IndexedDB / live API is hit. `now` is
 * pinned to known NYSE sessions so the trading-day window is deterministic. The
 * chosen week (Mon 2026-03-09 → Fri 2026-03-13) is clear of any market holiday.
 */
import { describe, expect, it, vi } from "vitest";

import { Decimal } from "../src/decimal-config";
import { buildIntradayAnchor, type AnchorHoldingInput } from "../src/intraday";
import {
  DEFAULT_WEEK_SESSIONS,
  WEEK_STORE_KEY,
  loadOrBuildWeekCurve,
  navBackfillStaleSymbols,
  navBarsFromQuotes,
  navSafeBarsForPriming,
  navTipCoveredSymbols,
  toDailyNavBars,
  weekStaleSymbols,
  wrapDailyNavFetcher,
  capWeekToSessionClose,
} from "../src/week";
import type { Bar, CurvePoint } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore, type StoredCloseProbe } from "../src/timeseries-store";
import { FX_PROBE_KEY } from "../src/close-completeness";
import { exchangeDayStartMs, sessionCloseMs, sessionOpenMs } from "../src/market-hours";

const d = (v: string | number): Decimal => new Decimal(v);
const bar = (t: number, value: string): Bar => ({ t, value: new Decimal(value) });
// Daily-close bars and the window grid are bucketed at 00:00 ET (the exchange
// trading-day start), matching production (`week.ts` dayStartMs / `parseBarTime`).
const dayMs = (day: string): number => exchangeDayStartMs(day);

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

describe("navBarsFromQuotes (remember NAVs for free, item 7a.1)", () => {
  it("stamps each fund's NAV at its authentic value-date, market symbols ignored", () => {
    const navSymbols = new Set(["FXAIX", "VMFXX"]);
    const bars = navBarsFromQuotes(
      [
        { symbol: "FXAIX", valueDate: "2026-03-12", price: d("180.5") },
        { symbol: "VMFXX", valueDate: "2026-03-12", price: d("1") },
        { symbol: "VTI", valueDate: "2026-03-12", price: d("250") }, // market — skipped
      ],
      navSymbols,
    );
    expect(Object.keys(bars).sort()).toEqual(["FXAIX", "VMFXX"]);
    expect(bars.FXAIX).toEqual([{ t: dayMs("2026-03-12"), value: d("180.5") }]);
  });

  it("skips quotes missing a value-date or a positive price", () => {
    const navSymbols = new Set(["FXAIX"]);
    expect(navBarsFromQuotes([{ symbol: "FXAIX", valueDate: null, price: d("1") }], navSymbols)).toEqual({});
    expect(navBarsFromQuotes([{ symbol: "FXAIX", valueDate: "2026-03-12", price: null }], navSymbols)).toEqual({});
    expect(navBarsFromQuotes([{ symbol: "FXAIX", valueDate: "2026-03-12", price: d("0") }], navSymbols)).toEqual({});
  });
});

describe("1W curve NAV funds (item 7)", () => {
  // A book that is half a market ETF, half a moving NAV fund.
  function mixedBook(): AnchorHoldingInput[] {
    return [
      holding({ priceSymbol: "VTI", priceType: "market", priceNative: d(100), valueEur: d(900), valueUsd: d(1000) }),
      holding({ priceSymbol: "FXAIX", priceType: "nav", priceNative: d(200), valueEur: d(900), valueUsd: d(1000) }),
    ];
  }

  it("re-marks the NAV fund from its stored daily-NAV bars, and never fetches funds", async () => {
    const s = store();
    // Pre-load both a market close history and the accumulated fund NAV history.
    await s.mergeSession(
      WEEK_STORE_KEY,
      {
        bars: {
          VTI: [bar(dayMs("2026-03-12"), "98"), bar(dayMs("2026-03-13"), "100")],
          FXAIX: [bar(dayMs("2026-03-12"), "190"), bar(dayMs("2026-03-13"), "200")],
        },
      },
      dayMs("2026-03-13"),
    );
    const anchor = buildIntradayAnchor(mixedBook(), d(0), d(0), d("0.9"), { navInSleeve: true });
    const fetched: string[][] = [];
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async (syms) => {
        fetched.push(syms);
        return new Map<string, Bar[]>();
      },
      now: SAT_CLOSED,
    });
    // The fund symbol is NEVER handed to the price fetcher — only the market one.
    for (const call of fetched) expect(call).not.toContain("FXAIX");
    // The fund contributes its own per-day NAV drift: the 03-12 point re-marks
    // FXAIX at 190/200 of its 1000 value (not a flat 1000).
    const at0312 = curve.points.find((p) => p.t === dayMs("2026-03-12"));
    expect(at0312).toBeDefined();
    // VTI: 1000·98/100 = 980 ; FXAIX: 1000·190/200 = 950 → 1930 USD.
    expect(at0312!.valueUsd.toString()).toBe("1930");
  });

  it("snaps a NAV fund's midnight close to the session open on an intraday-detailed day", async () => {
    const s = store();
    // Week cache: market + fund daily closes, both stamped at UTC midnight.
    await s.mergeSession(
      WEEK_STORE_KEY,
      {
        bars: {
          VTI: [bar(dayMs("2026-03-11"), "100"), bar(dayMs("2026-03-12"), "100")],
          FXAIX: [bar(dayMs("2026-03-11"), "200"), bar(dayMs("2026-03-12"), "200")],
        },
      },
      dayMs("2026-03-12"),
    );
    // Today (Thu) gained fine 1D detail for the market sleeve only — the NAV fund
    // strikes once a day, so it has no intraday bars.
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
    const anchor = buildIntradayAnchor(mixedBook(), d(0), d(0), d("0.9"), { navInSleeve: true });
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map<string, Bar[]>(),
      now: THU_OPEN,
    });
    const open = sessionOpenMs("2026-03-12");
    const dayStart = dayMs("2026-03-12");
    // The fund's UTC-midnight close must NOT leave a pre-open point on Thursday;
    // it is snapped up to the 09:30 ET open so the band shows only market hours.
    const preOpen = curve.points.filter((p) => p.t >= dayStart && p.t < open);
    expect(preOpen).toEqual([]);
    // The snapped fund close still re-marks the book at the session open (FXAIX
    // carried flat at 200/200·1000 = 1000, VTI flat at 1000 → 2000 USD).
    const atOpen = curve.points.find((p) => p.t === open);
    expect(atOpen).toBeDefined();
    expect(atOpen!.valueUsd.toString()).toBe("2000");
    // The fine intraday prints still lift the curve through the session
    // (VTI: 1000·110/100 = 1100 ; FXAIX flat at 1000 → 2100 USD).
    const lifted = curve.points.find((p) => p.t === Date.parse("2026-03-12T17:00:00Z"));
    expect(lifted!.valueUsd.toString()).toBe("2100");
  });

  it("does not re-pull market closes just because a fund NAV day is missing", async () => {
    const s = store();
    // Market fully covered through Friday; the fund has NO bars at all.
    await s.mergeSession(
      WEEK_STORE_KEY,
      { bars: { VTI: [bar(dayMs("2026-03-13"), "100")] } },
      dayMs("2026-03-13"),
    );
    const anchor = buildIntradayAnchor(mixedBook(), d(0), d(0), d("0.9"), { navInSleeve: true });
    let fetchedAny = false;
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        fetchedAny = true;
        return new Map<string, Bar[]>();
      },
      now: SAT_CLOSED,
    });
    // The market sleeve is covered, so no network pull fires despite the fund gap.
    expect(fetchedAny).toBe(false);
  });
});

describe("week constants", () => {
  it("defaults to a five-session window", () => {
    expect(DEFAULT_WEEK_SESSIONS).toBe(5);
  });
});

describe("weekStaleSymbols (refresh-dedup coverage test, item 5b)", () => {
  it("reports a symbol stale when the store holds only pre-settlement bars", () => {
    // Closed Saturday: the settled cutoff is Friday 03-13. A store carrying only
    // Wednesday's close is *present* but does not *cover* through settlement, so
    // the looser presence check would wrongly read it fresh — coverage must not.
    const stored = { bars: { VTI: [bar(dayMs("2026-03-11"), "98")] } };
    expect(weekStaleSymbols(stored, ["VTI"], SAT_CLOSED)).toEqual(["VTI"]);
  });

  it("reports a symbol fresh when a bar at/after the settled cutoff exists", () => {
    const stored = { bars: { VTI: [bar(dayMs("2026-03-13"), "100")] } };
    expect(weekStaleSymbols(stored, ["VTI"], SAT_CLOSED)).toEqual([]);
  });

  it("treats a missing or empty store as fully stale", () => {
    expect(weekStaleSymbols(null, ["VTI", "VOO"], SAT_CLOSED)).toEqual(["VTI", "VOO"]);
    expect(weekStaleSymbols({ bars: {} }, ["VTI"], SAT_CLOSED)).toEqual(["VTI"]);
  });

  it("uses the second-to-last session as the cutoff while the market is open", () => {
    // Thu 03-12 open: today rides the live tip, so Wednesday 03-11's close is the
    // latest *settled* one — a store covering through Wednesday reads fresh.
    const stored = { bars: { VTI: [bar(dayMs("2026-03-11"), "98")] } };
    expect(weekStaleSymbols(stored, ["VTI"], THU_OPEN)).toEqual([]);
    // ...but a store stopping at Tuesday is still stale mid-open-session.
    const older = { bars: { VTI: [bar(dayMs("2026-03-10"), "97")] } };
    expect(weekStaleSymbols(older, ["VTI"], THU_OPEN)).toEqual(["VTI"]);
  });

  it("matches the cutoff the build uses: a pre-settlement store is rebuilt, not reused", async () => {
    // End-to-end check that the dedup's coverage test agrees with the build. A
    // store holding only Wednesday's close on closed Saturday must be treated as
    // stale by BOTH weekStaleSymbols AND loadOrBuildWeekCurve (which re-fetches).
    const s = store();
    await s.mergeSession(
      WEEK_STORE_KEY,
      { bars: { VTI: [bar(dayMs("2026-03-11"), "98")] } },
      dayMs("2026-03-11"),
    );
    const pre = await s.loadSession(WEEK_STORE_KEY);
    expect(weekStaleSymbols(pre, ["VTI"], SAT_CLOSED)).toEqual(["VTI"]);
    let fetched = false;
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        fetched = true;
        return new Map<string, Bar[]>([["VTI", [bar(dayMs("2026-03-13"), "100")]]]);
      },
      now: SAT_CLOSED,
    });
    expect(fetched).toBe(true);
  });
});

describe("toDailyNavBars (re-stamp price bars to NAV day-start cadence, item 7b)", () => {
  it("collapses each UTC day to its last value at day-start", () => {
    // Session open (09:30 ET) + close (16:00 ET) bars for one day → one bar at
    // UTC midnight carrying the settling (close) value.
    const open = Date.parse("2026-03-13T13:30:00Z");
    const close = Date.parse("2026-03-13T20:00:00Z");
    const out = toDailyNavBars([bar(close, "101"), bar(open, "100")]);
    expect(out).toHaveLength(1);
    expect(out[0].t).toBe(dayMs("2026-03-13"));
    expect(out[0].value.toString()).toBe("101");
  });

  it("keeps one bar per day, ascending", () => {
    const out = toDailyNavBars([
      bar(Date.parse("2026-03-13T20:00:00Z"), "101"),
      bar(Date.parse("2026-03-12T20:00:00Z"), "100"),
    ]);
    expect(out.map((b) => b.t)).toEqual([dayMs("2026-03-12"), dayMs("2026-03-13")]);
  });
});

describe("navBackfillStaleSymbols (item 7b gap detection)", () => {
  it("flags a moving fund missing any settled-session NAV day", () => {
    // Window Mon 03-09 → Fri 03-13 (closed Sat). Only Friday's NAV is stored.
    const stored = { bars: { FXAIX: [bar(dayMs("2026-03-13"), "100")] } };
    expect(navBackfillStaleSymbols(stored, ["FXAIX"], SAT_CLOSED)).toEqual(["FXAIX"]);
  });

  it("is clean once every settled session day is covered", () => {
    const stored = {
      bars: {
        FXAIX: [
          bar(dayMs("2026-03-09"), "96"),
          bar(dayMs("2026-03-10"), "97"),
          bar(dayMs("2026-03-11"), "98"),
          bar(dayMs("2026-03-12"), "99"),
          bar(dayMs("2026-03-13"), "100"),
        ],
      },
    };
    expect(navBackfillStaleSymbols(stored, ["FXAIX"], SAT_CLOSED)).toEqual([]);
  });

  it("does not require today's NAV while the market is open", () => {
    // Thu open: settled sessions are Fri 03-06..Wed 03-11; Thursday's NAV is not
    // expected (the live tip carries today).
    const stored = {
      bars: {
        FXAIX: [
          bar(dayMs("2026-03-06"), "95"),
          bar(dayMs("2026-03-09"), "96"),
          bar(dayMs("2026-03-10"), "97"),
          bar(dayMs("2026-03-11"), "98"),
        ],
      },
    };
    expect(navBackfillStaleSymbols(stored, ["FXAIX"], THU_OPEN)).toEqual([]);
  });

  it("treats an empty / missing store as fully stale", () => {
    expect(navBackfillStaleSymbols(null, ["FXAIX"], SAT_CLOSED)).toEqual(["FXAIX"]);
  });
});

describe("navTipCoveredSymbols (only drop genuinely-current funds from the quote leg, #184)", () => {
  // SAT_CLOSED → latest settled session is Fri 2026-03-13.
  const settled = "2026-03-13";

  it("covers a fund whose freshest bar reaches the latest settled session", () => {
    const bars = new Map([
      ["FXAIX", [bar(dayMs("2026-03-12"), "99"), bar(dayMs("2026-03-13"), "100")]],
    ]);
    expect(navTipCoveredSymbols(bars, settled)).toEqual(["FXAIX"]);
  });

  it("does NOT cover a fund whose freshest bar is still behind — it stays on the quote leg", () => {
    // The bar source (Tiingo /price) lagged: newest bar is Wed, not Fri. Twelve
    // Data may still hold Friday's NAV, so this fund must not be dropped.
    const bars = new Map([
      ["FXAIX", [bar(dayMs("2026-03-10"), "97"), bar(dayMs("2026-03-11"), "98")]],
    ]);
    expect(navTipCoveredSymbols(bars, settled)).toEqual([]);
  });

  it("covers a fund whose tip is ahead of the settled floor", () => {
    const bars = new Map([["FXAIX", [bar(dayMs("2026-03-16"), "101")]]]);
    expect(navTipCoveredSymbols(bars, settled)).toEqual(["FXAIX"]);
  });

  it("ignores funds with no bars and reports each independently", () => {
    const bars = new Map([
      ["CURRENT", [bar(dayMs("2026-03-13"), "100")]],
      ["BEHIND", [bar(dayMs("2026-03-11"), "98")]],
      ["EMPTY", [] as ReturnType<typeof bar>[]],
    ]);
    expect(navTipCoveredSymbols(bars, settled)).toEqual(["CURRENT"]);
  });
});

describe("navSafeBarsForPriming (normal/manual-refresh prime guard, #191 root cause)", () => {
  // SAT_CLOSED → latest settled session is Fri 2026-03-13.
  const settled = "2026-03-13";

  it("keeps a current NAV fund and marks it covered", () => {
    const bars = new Map([["FXAIX", [bar(dayMs("2026-03-13"), "100")]]]);
    const { bars: out, navCovered } = navSafeBarsForPriming(bars, new Set(["FXAIX"]), settled);
    expect([...out.keys()]).toEqual(["FXAIX"]);
    expect([...navCovered]).toEqual(["FXAIX"]);
  });

  it("drops a stale NAV fund so its old tip never becomes the headline", () => {
    // Tiingo /price lagged: newest bar is Wed, two sessions behind Friday. The
    // fund must NOT be primed (it would pin the headline on an old day); it stays
    // on its genuine quote / the NAV quote leg for a real fetch.
    const bars = new Map([["FXAIX", [bar(dayMs("2026-03-11"), "98")]]]);
    const { bars: out, navCovered } = navSafeBarsForPriming(bars, new Set(["FXAIX"]), settled);
    expect(out.size).toBe(0);
    expect(navCovered.size).toBe(0);
  });

  it("always passes market (non-NAV) bars through untouched", () => {
    // A market symbol that happens to carry an old bar is still primed — only NAV
    // funds are gated on reaching the settled session.
    const bars = new Map([
      ["VTI", [bar(dayMs("2026-03-10"), "300")]],
      ["FXAIX", [bar(dayMs("2026-03-11"), "98")]],
    ]);
    const { bars: out, navCovered } = navSafeBarsForPriming(bars, new Set(["FXAIX"]), settled);
    expect([...out.keys()]).toEqual(["VTI"]);
    expect(navCovered.size).toBe(0);
  });

  it("primes a current NAV fund while dropping a stale sibling in one pass", () => {
    const bars = new Map([
      ["CURRENT", [bar(dayMs("2026-03-13"), "100")]],
      ["BEHIND", [bar(dayMs("2026-03-11"), "98")]],
      ["MKT", [bar(dayMs("2026-03-12"), "50")]],
    ]);
    const { bars: out, navCovered } = navSafeBarsForPriming(
      bars,
      new Set(["CURRENT", "BEHIND"]),
      settled,
    );
    expect([...out.keys()].sort()).toEqual(["CURRENT", "MKT"]);
    expect([...navCovered]).toEqual(["CURRENT"]);
  });
});

describe("loadOrBuildWeekCurve NAV gap-fill (item 7b)", () => {
  // A moving NAV fund in the week sleeve (navInSleeve), with one stored login-day
  // NAV bar but holes across the rest of the window.
  const navHolding = (): AnchorHoldingInput =>
    holding({
      priceSymbol: "FXAIX",
      priceType: "nav",
      nativeCurrency: "USD",
      shares: d(5),
      priceNative: d(100),
      valueEur: d(450),
      valueUsd: d(500),
    });

  it("backfills missing moving-fund NAV days through fetchNavBars", async () => {
    const s = store();
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: {
        VTI: [bar(dayMs("2026-03-12"), "99"), bar(dayMs("2026-03-13"), "100")],
        FXAIX: [bar(dayMs("2026-03-13"), "100")], // only Friday cached so far
      },
      fx: [],
      updatedAt: 0,
    });
    const anchor = buildIntradayAnchor([holding(), navHolding()], d(0), d(0), d("0.9"), {
      navInSleeve: true,
    });
    const requested: string[][] = [];
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      fetchNavBars: async (symbols) => {
        requested.push(symbols);
        return new Map([
          [
            "FXAIX",
            [
              bar(dayMs("2026-03-09"), "96"),
              bar(dayMs("2026-03-10"), "97"),
              bar(dayMs("2026-03-11"), "98"),
              bar(dayMs("2026-03-12"), "99"),
            ],
          ],
        ]);
      },
      navBackfillSymbols: ["FXAIX"],
      now: SAT_CLOSED,
    });
    expect(requested).toEqual([["FXAIX"]]);
    const reread = await s.loadSession(WEEK_STORE_KEY);
    // All five settled sessions are now covered for the moving fund.
    expect(navBackfillStaleSymbols(reread, ["FXAIX"], SAT_CLOSED)).toEqual([]);
  });

  it("announces the gap-fill via onNavBackfill (polling-log visibility)", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([navHolding()], d(0), d(0), d("0.9"), { navInSleeve: true });
    const announced: string[][] = [];
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      fetchNavBars: async () => new Map([["FXAIX", [bar(dayMs("2026-03-13"), "100")]]]),
      navBackfillSymbols: ["FXAIX"],
      onNavBackfill: (symbols) => announced.push(symbols),
      now: SAT_CLOSED,
    });
    expect(announced).toEqual([["FXAIX"]]);
  });

  it("does not fetch when the moving fund is already fully covered", async () => {
    const s = store();
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: {
        FXAIX: [
          bar(dayMs("2026-03-09"), "96"),
          bar(dayMs("2026-03-10"), "97"),
          bar(dayMs("2026-03-11"), "98"),
          bar(dayMs("2026-03-12"), "99"),
          bar(dayMs("2026-03-13"), "100"),
        ],
      },
      fx: [],
      updatedAt: 0,
    });
    const anchor = buildIntradayAnchor([navHolding()], d(0), d(0), d("0.9"), { navInSleeve: true });
    let fetched = false;
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      fetchNavBars: async () => {
        fetched = true;
        return new Map();
      },
      navBackfillSymbols: ["FXAIX"],
      now: SAT_CLOSED,
    });
    expect(fetched).toBe(false);
  });

  it("never fetches a money-market fund (absent from navBackfillSymbols)", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([navHolding()], d(0), d(0), d("0.9"), { navInSleeve: true });
    let fetched = false;
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => new Map(),
      fetchNavBars: async () => {
        fetched = true;
        return new Map();
      },
      navBackfillSymbols: [], // money-market funds are excluded by the caller
      now: SAT_CLOSED,
    });
    expect(fetched).toBe(false);
  });
});

describe("wrapDailyNavFetcher (item 7b cadence normaliser)", () => {
  it("re-stamps each symbol's price bars onto NAV day-start", async () => {
    const inner = async (): Promise<Map<string, Bar[]>> =>
      new Map([
        [
          "FXAIX",
          [
            bar(Date.parse("2026-03-12T13:30:00Z"), "98"),
            bar(Date.parse("2026-03-12T20:00:00Z"), "99"),
            bar(Date.parse("2026-03-13T20:00:00Z"), "100"),
          ],
        ],
      ]);
    const wrapped = wrapDailyNavFetcher(inner);
    const out = await wrapped(["FXAIX"]);
    const bars = out.get("FXAIX") ?? [];
    expect(bars.map((b) => b.t)).toEqual([dayMs("2026-03-12"), dayMs("2026-03-13")]);
    expect(bars.map((b) => b.value.toString())).toEqual(["99", "100"]);
  });
});

describe("loadOrBuildWeekCurve — regenerateOnly seam (Pillar 6)", () => {
  it("never fetches daily closes, NAV gap-fill, or FX when regenerateOnly is set", async () => {
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    let fetched = false;
    let navFetched = false;
    let fxFetched = false;
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: store(),
      regenerateOnly: true,
      navBackfillSymbols: ["VTI"],
      fetchDailyBars: async () => {
        fetched = true;
        return new Map<string, Bar[]>();
      },
      fetchNavBars: async () => {
        navFetched = true;
        return new Map<string, Bar[]>();
      },
      fetchFx: async () => {
        fxFetched = true;
        return [] as Bar[];
      },
      now: SAT_CLOSED,
    });
    expect(fetched).toBe(false);
    expect(navFetched).toBe(false);
    expect(fxFetched).toBe(false);
    // An empty store under regenerate-only simply yields no drawable curve.
    expect(curve.points.length).toBe(0);
  });

  it("reconstructs from already-stored closes without any network call", async () => {
    const s = store();
    const anchor = buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
    // Seed via a normal fetching build.
    let seeded = false;
    await loadOrBuildWeekCurve({
      anchor,
      store: s,
      fetchDailyBars: async () => {
        seeded = true;
        return new Map([["VTI", [bar(dayMs("2026-03-11"), "98"), bar(dayMs("2026-03-12"), "99"), bar(dayMs("2026-03-13"), "100")]]]);
      },
      now: SAT_CLOSED,
    });
    expect(seeded).toBe(true);

    let refetched = false;
    const curve = await loadOrBuildWeekCurve({
      anchor,
      store: s,
      regenerateOnly: true,
      fetchDailyBars: async () => {
        refetched = true;
        return new Map<string, Bar[]>();
      },
      now: SAT_CLOSED,
    });
    expect(refetched).toBe(false);
    expect(curve.points.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadOrBuildWeekCurve — multi-provider close completeness (C5)", () => {
  // The window Mon 03-09 → Fri 03-13 with the market closed (SAT_CLOSED): the
  // settled cutoff is Friday 03-13. A "behind" market symbol has bars only up to
  // Thursday 03-12 — it has not yet covered the settled close.
  const CUT = dayMs("2026-03-13");
  const THU = dayMs("2026-03-12");

  function anchor() {
    return buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
  }

  async function seedBehind(s: TimeSeriesStore): Promise<void> {
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(dayMs("2026-03-11"), "98"), bar(THU, "99")] },
      fx: [],
      updatedAt: 0,
    });
  }

  function fakeBackoff() {
    const fails = new Map<string, number>();
    const armed = new Set<string>();
    return {
      fails,
      armed,
      suppressed: (k: string): boolean => armed.has(k),
      fail: (k: string): void => {
        fails.set(k, (fails.get(k) ?? 0) + 1);
      },
      succeed: (k: string): void => {
        fails.delete(k);
        armed.delete(k);
      },
    };
  }

  it("reached-close: the primary supplies the settled day ⇒ merge + clear probe", async () => {
    const s = store();
    await seedBehind(s);
    const fetchDailyBars = vi.fn(async () => new Map<string, Bar[]>([["VTI", [bar(CUT, "100")]]]));
    const log: { outcome: string; level: string; message: string }[] = [];
    await loadOrBuildWeekCurve({
      anchor: anchor(),
      store: s,
      fetchDailyBars,
      now: SAT_CLOSED,
      onCloseResolve: (e) => log.push(e),
    });
    expect(fetchDailyBars).toHaveBeenCalledTimes(1);
    const stored = (await s.loadSession(WEEK_STORE_KEY))!;
    expect(stored.bars.VTI.some((b) => b.t === CUT)).toBe(true);
    expect(stored.closeProbe).toBeUndefined();
    expect(log.some((l) => l.outcome === "reached-close" && l.level === "good")).toBe(true);
    expect(log.every((l) => l.message.startsWith("1W graph · VTI"))).toBe(true);
  });

  it("settled-by-agreement: two providers must agree 3× (hour-paced) before a daily close settles, no re-fetch after", async () => {
    const s = store();
    await seedBehind(s);
    const fetchDailyBars = vi.fn(async () => new Map<string, Bar[]>([["VTI", [bar(THU, "99")]]]));
    const fetchSecondaryDailyBars = vi.fn(async () => new Map<string, Bar[]>([["VTI", [bar(THU, "99")]]]));
    const log: { outcome: string; level: string; message: string }[] = [];
    const build = (now: Date): Promise<unknown> =>
      loadOrBuildWeekCurve({
        anchor: anchor(),
        store: s,
        fetchDailyBars,
        fetchSecondaryDailyBars,
        now,
        onCloseResolve: (e) => log.push(e),
      });
    const probeNow = async (): Promise<StoredCloseProbe> =>
      (await s.loadSession(WEEK_STORE_KEY))!.closeProbe!.VTI;

    // Agreement #1 at 16:00Z — provisional only.
    await build(SAT_CLOSED);
    expect(fetchDailyBars).toHaveBeenCalledTimes(1);
    expect(fetchSecondaryDailyBars).toHaveBeenCalledTimes(1);
    let probe = await probeNow();
    expect(probe.settled).toBe(false);
    expect(probe.sources).toBe(2);
    expect(probe.agreements).toBe(1);

    // Held flat until the next full hour (no fetch on a sub-hour redraw).
    fetchDailyBars.mockClear();
    fetchSecondaryDailyBars.mockClear();
    await build(new Date(SAT_CLOSED.getTime() + 5 * 60_000)); // 16:05Z
    expect(fetchDailyBars).not.toHaveBeenCalled();

    // Agreements #2 (17:00Z) and #3 (18:00Z) ⇒ settled on the third.
    await build(new Date(Date.parse("2026-03-14T17:00:00Z")));
    expect((await probeNow()).agreements).toBe(2);
    await build(new Date(Date.parse("2026-03-14T18:00:00Z")));
    probe = await probeNow();
    expect(probe.settled).toBe(true);
    expect(probe.sources).toBe(2);
    expect(probe.agreements).toBe(3);
    expect(log.some((l) => l.outcome === "settled-by-agreement" && l.level === "good")).toBe(true);

    // Next build: the symbol is settled ⇒ neither provider is asked again.
    fetchDailyBars.mockClear();
    fetchSecondaryDailyBars.mockClear();
    await build(new Date(Date.parse("2026-03-14T19:00:00Z")));
    expect(fetchDailyBars).not.toHaveBeenCalled();
    expect(fetchSecondaryDailyBars).not.toHaveBeenCalled();
  });

  it("deferred-outage: both providers empty ⇒ not settled, back-off struck under the 1W scope", async () => {
    const s = store();
    await seedBehind(s);
    const fetchDailyBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchSecondaryDailyBars = vi.fn(async () => new Map<string, Bar[]>());
    const backoff = fakeBackoff();
    const log: { outcome: string; level: string; message: string }[] = [];
    await loadOrBuildWeekCurve({
      anchor: anchor(),
      store: s,
      fetchDailyBars,
      fetchSecondaryDailyBars,
      closeBackoff: backoff,
      now: SAT_CLOSED,
      onCloseResolve: (e) => log.push(e),
    });
    const probe = (await s.loadSession(WEEK_STORE_KEY))!.closeProbe!.VTI;
    expect(probe.settled).toBe(false);
    expect(backoff.fails.get("close:1W:VTI")).toBe(1);
    expect(log.some((l) => l.outcome === "deferred-outage" && l.level === "warn")).toBe(true);
  });

  it("spacing gate (C4): a behind symbol probed moments ago is held flat — no fetch", async () => {
    const s = store();
    await seedBehind(s);
    await s.mergeSession(
      WEEK_STORE_KEY,
      {
        closeProbe: {
          VTI: { lastBarAt: THU, attempts: 1, sources: 1, settled: false, lastAttemptAt: SAT_CLOSED.getTime() - 60_000 },
        },
      },
      0,
    );
    const fetchDailyBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildWeekCurve({ anchor: anchor(), store: s, fetchDailyBars, now: SAT_CLOSED });
    expect(fetchDailyBars).not.toHaveBeenCalled();
  });

  it("honors a persisted settled probe across a restart (zero fetches)", async () => {
    const s = store();
    await seedBehind(s);
    await s.mergeSession(
      WEEK_STORE_KEY,
      {
        closeProbe: {
          VTI: { lastBarAt: THU, attempts: 2, sources: 2, settled: true, lastAttemptAt: 1 },
        },
      },
      0,
    );
    const fetchDailyBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildWeekCurve({ anchor: anchor(), store: s, fetchDailyBars, now: SAT_CLOSED });
    expect(fetchDailyBars).not.toHaveBeenCalled();
  });
});

describe("loadOrBuildWeekCurve — FX-track completeness (C5 currency parity)", () => {
  const CUT = dayMs("2026-03-13");
  const THU = dayMs("2026-03-12");

  function anchor() {
    return buildIntradayAnchor([holding()], d(0), d(0), d("0.9"));
  }

  it("advances an incomplete-but-present FX track to the settled close, then stops re-pulling", async () => {
    const s = store();
    // Prices already cover the settled close (so they never gate FX), but the FX
    // track stops on Thursday — short of Friday's settled cutoff.
    await s.saveSession({
      day: WEEK_STORE_KEY,
      bars: { VTI: [bar(THU, "99"), bar(CUT, "100")] },
      fx: [bar(THU, "1.00")],
      updatedAt: 0,
    });
    const fetchDailyBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [bar(CUT, "1.10")]); // reaches the settled close
    await loadOrBuildWeekCurve({
      anchor: anchor(),
      store: s,
      fetchDailyBars,
      fetchFx,
      now: SAT_CLOSED,
    });
    expect(fetchDailyBars).not.toHaveBeenCalled(); // prices already settled
    expect(fetchFx).toHaveBeenCalledTimes(1);
    const stored = (await s.loadSession(WEEK_STORE_KEY))!;
    expect(stored.fx.some((b) => b.t === CUT)).toBe(true);
    expect(stored.closeProbe?.[FX_PROBE_KEY]).toBeUndefined(); // reached-close clears it

    // Redraw: FX now covers the settled close ⇒ no further FX pull.
    fetchFx.mockClear();
    await loadOrBuildWeekCurve({ anchor: anchor(), store: s, fetchDailyBars, fetchFx, now: SAT_CLOSED });
    expect(fetchFx).not.toHaveBeenCalled();
  });
});

describe("capWeekToSessionClose", () => {
  const pt = (t: number, eur: string, usd: string): CurvePoint => ({
    t,
    valueEur: d(eur),
    valueUsd: d(usd),
  });
  // Friday is the last session for both the closed and open reference instants.
  const FRI = "2026-03-13";
  const friClose = sessionCloseMs(FRI);

  it("drops a trailing point past the last session close when the market is shut", () => {
    // A spurious blob market_series sample stamped 30 min after the 16:00 ET close
    // (with a low USD value + low FX, the divergent USD/EUR nosedive signature).
    const points = [
      pt(friClose - 60 * 60 * 1000, "53.50", "53.55"),
      pt(friClose, "53.49", "53.52"),
      pt(friClose + 30 * 60 * 1000, "53.33", "53.08"),
    ];
    const capped = capWeekToSessionClose(points, SAT_CLOSED);
    expect(capped).toHaveLength(2);
    expect(capped[capped.length - 1].t).toBe(friClose);
    expect(capped.some((p) => p.t > friClose)).toBe(false);
  });

  it("leaves an in-session curve untouched while the market is open", () => {
    const points = [pt(friClose - 2 * 60 * 60 * 1000, "53.5", "53.5"), pt(friClose - 60 * 60 * 1000, "53.6", "53.6")];
    expect(capWeekToSessionClose(points, THU_OPEN)).toEqual(points);
  });

  it("keeps the curve rather than blanking it when every point is post-close", () => {
    // capAtClose's safety net: a curve made only of post-close points is returned
    // as-is rather than emptied (mirrors the 1D builder).
    const points = [pt(friClose + 10 * 60 * 1000, "53.4", "53.4"), pt(friClose + 20 * 60 * 1000, "53.3", "53.0")];
    expect(capWeekToSessionClose(points, SAT_CLOSED)).toEqual(points);
  });
});
