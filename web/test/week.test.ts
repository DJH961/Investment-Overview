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
