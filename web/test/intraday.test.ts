/**
 * Tests for the live 1D intraday curve orchestration (`intraday.ts`, Phase 2).
 * Network and persistence are injected, so no DOM / IndexedDB / live API is hit.
 */
import { describe, expect, it, vi } from "vitest";

import { Decimal } from "../src/decimal-config";
import {
  appendLiveTip,
  buildIntradayAnchor,
  capAtClose,
  intradaySymbols,
  loadOrBuildSessionCurve,
  type AnchorHoldingInput,
  type IntradayAnchor,
} from "../src/intraday";
import type { Bar, CurvePoint } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";

const d = (v: string | number): Decimal => new Decimal(v);
const bar = (t: number, value: string): Bar => ({ t, value: new Decimal(value) });

function holding(over: Partial<AnchorHoldingInput>): AnchorHoldingInput {
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

describe("buildIntradayAnchor", () => {
  it("splits the intraday sleeve from the constant cash + NAV base", () => {
    const anchor = buildIntradayAnchor(
      [
        holding({ priceSymbol: "VTI" }),
        holding({ priceSymbol: "FXAIX", priceType: "nav", valueEur: d(50), valueUsd: d(55) }),
      ],
      d(100), // cash EUR
      d(110), // cash USD
      d("0.9"),
    );
    expect(anchor.holdings.map((h) => h.priceSymbol)).toEqual(["VTI"]);
    // base = cash + the NAV fund's value.
    expect(anchor.baseEur.toString()).toBe("150");
    expect(anchor.baseUsd.toString()).toBe("165");
    expect(anchor.baseFx!.toString()).toBe("0.9");
  });

  it("excludes unpriced, zero-price, and dust-share holdings from the sleeve", () => {
    const anchor = buildIntradayAnchor(
      [
        holding({ priceSymbol: "A", priceNative: null }),
        holding({ priceSymbol: "B", priceNative: d(0) }),
        holding({ priceSymbol: "C", shares: d("0.00000001") }),
        holding({ priceSymbol: "D" }),
      ],
      d(0),
      d(0),
      null,
    );
    expect(anchor.holdings.map((h) => h.priceSymbol)).toEqual(["D"]);
    // A/B/C are still valued — they fold into the base, not dropped.
    expect(anchor.baseEur.toString()).toBe("2700"); // three × 900
  });

  it("drops holdings with no EUR value entirely (neither sleeve nor base)", () => {
    const anchor = buildIntradayAnchor([holding({ valueEur: null })], d(10), d(10), null);
    expect(anchor.holdings).toHaveLength(0);
    expect(anchor.baseEur.toString()).toBe("10");
  });

  it("falls back to the EUR value when a holding has no USD twin", () => {
    const anchor = buildIntradayAnchor(
      [holding({ priceType: "nav", valueEur: d(40), valueUsd: null })],
      d(0),
      d(0),
      null,
    );
    expect(anchor.baseUsd.toString()).toBe("40");
  });
});

describe("intradaySymbols", () => {
  it("returns the distinct tickers of the sleeve", () => {
    const anchor: IntradayAnchor = {
      holdings: [
        { priceSymbol: "VTI", valueEur: d(1), valueUsd: d(1), closeNative: d(1), isUsdNative: true },
        { priceSymbol: "VTI", valueEur: d(1), valueUsd: d(1), closeNative: d(1), isUsdNative: true },
        { priceSymbol: "QQQ", valueEur: d(1), valueUsd: d(1), closeNative: d(1), isUsdNative: true },
      ],
      baseEur: d(0),
      baseUsd: d(0),
      baseFx: null,
    };
    expect(intradaySymbols(anchor)).toEqual(["VTI", "QQQ"]);
  });
});

describe("appendLiveTip", () => {
  const points: CurvePoint[] = [
    { t: 100, valueEur: d(10), valueUsd: d(11) },
    { t: 200, valueEur: d(20), valueUsd: d(22) },
  ];

  it("appends a newer tip", () => {
    const out = appendLiveTip(points, 300, { valueEur: d(30), valueUsd: d(33) });
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ t: 300, valueEur: d(30), valueUsd: d(33) });
  });

  it("replaces the final point when the tip shares its instant", () => {
    const out = appendLiveTip(points, 200, { valueEur: d(25), valueUsd: d(27) });
    expect(out).toHaveLength(2);
    expect(out[1].valueEur.toString()).toBe("25");
  });

  it("ignores a tip older than the last bar", () => {
    const out = appendLiveTip(points, 150, { valueEur: d(99), valueUsd: d(99) });
    expect(out).toBe(points);
  });

  it("seeds a lone tip onto an empty curve", () => {
    const out = appendLiveTip([], 100, { valueEur: d(5), valueUsd: d(6) });
    expect(out).toEqual([{ t: 100, valueEur: d(5), valueUsd: d(6) }]);
  });
});

describe("capAtClose", () => {
  const points: CurvePoint[] = [
    { t: 100, valueEur: d(1), valueUsd: d(1) },
    { t: 200, valueEur: d(2), valueUsd: d(2) },
    { t: 300, valueEur: d(3), valueUsd: d(3) },
  ];

  it("drops points after the close", () => {
    expect(capAtClose(points, 200).map((p) => p.t)).toEqual([100, 200]);
  });

  it("returns the curve untouched rather than blanking it", () => {
    expect(capAtClose(points, 50)).toBe(points);
  });
});

describe("loadOrBuildSessionCurve", () => {
  // One USD-booked ETF, base of 100 in each currency, no FX bars (EUR rides the
  // settled rate). At a bar equal to the close-native (100) the holding marks at
  // its full live value, so the point lands on base + value.
  function singleEtfAnchor(): IntradayAnchor {
    return {
      holdings: [
        { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true },
      ],
      baseEur: d(100),
      baseUsd: d(100),
      baseFx: d("0.9"),
    };
  }

  it("cold-fetches, reconstructs, and pins the live tip while open", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const fetchBars = vi.fn(async () =>
      new Map<string, Bar[]>([["VTI", [bar(Date.parse("2026-06-23T13:35:00Z"), "90")]]]),
    );
    // Mid-session: Tue 2026-06-23 14:00 UTC == 10:00 ET.
    const now = new Date("2026-06-23T14:00:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      liveTip: { valueEur: d(1010), valueUsd: d(1110) },
    });

    expect(fetchBars).toHaveBeenCalledOnce();
    expect(result.day).toBe("2026-06-23");
    expect(result.marketOpen).toBe(true);
    // One reconstructed bar (price 90 → 1000·0.9 + base 100 = 1000 USD) then the
    // live tip pinned at `now`.
    expect(result.points).toHaveLength(2);
    expect(result.points[0].valueUsd.toString()).toBe("1000");
    expect(result.points[1]).toEqual({
      t: now.getTime(),
      valueEur: d(1010),
      valueUsd: d(1110),
    });
  });

  it("reconstructs the USD curve FX-free off the stored bars", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const fetchBars = vi.fn(async () =>
      new Map<string, Bar[]>([
        [
          "VTI",
          [bar(Date.parse("2026-06-23T13:35:00Z"), "90"), bar(Date.parse("2026-06-23T15:00:00Z"), "100")],
        ],
      ]),
    );
    const now = new Date("2026-06-23T15:05:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      liveTip: null,
    });
    // price 90: 1000·(90/100)=900 + base 100 = 1000 USD.
    // price 100: 1000·(100/100)=1000 + base 100 = 1100 USD.
    expect(result.points.map((p) => p.valueUsd.toString())).toEqual(["1000", "1100"]);
  });

  it("does not re-fetch a day already on the device when the market is closed", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T15:00:00Z"), "100")] },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    // After the close: Tue 2026-06-23 22:00 UTC == 18:00 ET.
    const now = new Date("2026-06-23T22:00:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(result.marketOpen).toBe(false);
    expect(result.points).toHaveLength(1);
  });

  it("does not re-fetch open-market bars written within the throttle window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    // Mid-session: Tue 2026-06-23 14:00 UTC == 10:00 ET.
    const now = new Date("2026-06-23T14:00:00Z");
    // Cache was written 20s ago — inside the default 60s throttle.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T13:35:00Z"), "100")] },
      fx: [],
      updatedAt: now.getTime() - 20_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const result = await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(result.marketOpen).toBe(true);
  });

  it("re-fetches open-market bars once the throttle window has elapsed", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T14:00:00Z");
    // Cache is 5 minutes old — past the 60s throttle, so a refresh is due.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T13:35:00Z"), "100")] },
      fx: [],
      updatedAt: now.getTime() - 5 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
    expect(fetchBars).toHaveBeenCalledOnce();
  });

  it("minRefetchMs=0 always refreshes while the market is open", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T14:00:00Z");
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T13:35:00Z"), "100")] },
      fx: [],
      updatedAt: now.getTime(),
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      minRefetchMs: 0,
    });
    expect(fetchBars).toHaveBeenCalledOnce();
  });

  it("caps the curve at the 16:00 ET close once the session has shut", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2026-06-23", {
      bars: {
        VTI: [
          bar(Date.parse("2026-06-23T15:00:00Z"), "100"),
          bar(Date.parse("2026-06-23T19:55:00Z"), "101"),
          // A stray post-close bar (e.g. an after-hours print) must be dropped.
          bar(Date.parse("2026-06-23T21:00:00Z"), "105"),
        ],
      },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const now = new Date("2026-06-23T22:00:00Z");
    const result = await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
    // Close is 20:00 UTC; the 21:00 UTC bar is capped away.
    expect(result.points.map((p) => p.t)).toEqual([
      Date.parse("2026-06-23T15:00:00Z"),
      Date.parse("2026-06-23T19:55:00Z"),
    ]);
  });

  it("returns an empty curve (no fetch) when the sleeve is empty", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const result = await loadOrBuildSessionCurve({
      anchor: { holdings: [], baseEur: d(100), baseUsd: d(100), baseFx: null },
      store,
      fetchBars,
      now: new Date("2026-06-23T14:00:00Z"),
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(result.points).toEqual([]);
  });

  it("survives an FX fetch failure, falling back to baseFx", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const fetchBars = vi.fn(async () =>
      new Map<string, Bar[]>([["VTI", [bar(Date.parse("2026-06-23T15:00:00Z"), "100")]]]),
    );
    const fetchFx = vi.fn(async () => {
      throw new Error("fx down");
    });
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchFx,
      now: new Date("2026-06-23T15:05:00Z"),
    });
    expect(fetchFx).toHaveBeenCalled();
    expect(result.points).toHaveLength(1);
  });

  it("prunes stored sessions outside the rolling retention window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    for (const day of ["2026-06-01", "2026-06-22", "2026-06-23"]) {
      await store.mergeSession(day, { bars: { VTI: [bar(1, "100")] } });
    }
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now: new Date("2026-06-23T22:00:00Z"),
      retainSessions: 2, // keep 2026-06-23 and the prior session only
    });
    const days = await store.listDays();
    expect(days).toEqual(["2026-06-22", "2026-06-23"]);
  });
});
