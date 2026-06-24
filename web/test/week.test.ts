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
  navBackfillStaleSymbols,
  navBarsFromQuotes,
  toDailyNavBars,
  weekStaleSymbols,
  wrapDailyNavFetcher,
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
