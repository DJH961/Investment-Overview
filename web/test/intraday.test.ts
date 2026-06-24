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
  mergeBreadcrumbs,
  rebaseBreadcrumbs,
  type AnchorHoldingInput,
  type IntradayAnchor,
} from "../src/intraday";
import type { Bar, CurvePoint } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore, type Breadcrumb } from "../src/timeseries-store";

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

describe("mergeBreadcrumbs", () => {
  const barPoints: CurvePoint[] = [
    { t: 100, valueEur: d(1), valueUsd: d(1) },
    { t: 200, valueEur: d(2), valueUsd: d(2) },
  ];

  it("returns the curve untouched when there are no breadcrumbs", () => {
    expect(mergeBreadcrumbs(barPoints, [])).toBe(barPoints);
  });

  it("falls back to the breadcrumb trail when the curve is empty", () => {
    const tips: CurvePoint[] = [
      { t: 300, valueEur: d(3), valueUsd: d(3) },
      { t: 100, valueEur: d(1), valueUsd: d(1) },
    ];
    expect(mergeBreadcrumbs([], tips).map((p) => p.t)).toEqual([100, 300]);
  });

  it("splices only breadcrumbs after the freshest bar (real bars win)", () => {
    const tips: CurvePoint[] = [
      { t: 150, valueEur: d(9), valueUsd: d(9) }, // before the last bar — superseded
      { t: 250, valueEur: d(5), valueUsd: d(5) },
      { t: 300, valueEur: d(6), valueUsd: d(6) },
    ];
    expect(mergeBreadcrumbs(barPoints, tips).map((p) => p.t)).toEqual([100, 200, 250, 300]);
  });

  it("drops breadcrumbs at or before the last bar instant", () => {
    const tips: CurvePoint[] = [{ t: 200, valueEur: d(9), valueUsd: d(9) }];
    expect(mergeBreadcrumbs(barPoints, tips)).toBe(barPoints);
  });
});

describe("rebaseBreadcrumbs", () => {
  it("shifts a base-tagged crumb by the change in base (NAV strike / FX move)", () => {
    // Struck at base 100; the current base has risen to 250 (an intraday NAV mark).
    const tips: Breadcrumb[] = [
      { t: 100, valueEur: d(1000), valueUsd: d(1100), baseEur: d(100), baseUsd: d(100) },
    ];
    const out = rebaseBreadcrumbs(tips, d(250), d(260));
    // 1000 − 100 + 250 = 1150 ; 1100 − 100 + 260 = 1260 — the market component is
    // preserved while the whole trail rides the new base.
    expect(out).toEqual([{ t: 100, valueEur: d(1150), valueUsd: d(1260) }]);
  });

  it("passes a legacy (untagged) crumb through unchanged", () => {
    const tips: Breadcrumb[] = [{ t: 100, valueEur: d(1000), valueUsd: d(1100) }];
    const out = rebaseBreadcrumbs(tips, d(250), d(260));
    expect(out).toEqual([{ t: 100, valueEur: d(1000), valueUsd: d(1100) }]);
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
    // Cache was written 20s ago — well inside the default open-market throttle.
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

  it("does not re-fetch open-market bars on a cadence — breadcrumbs carry the curve (default)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T14:00:00Z");
    // Bars were fetched 5 minutes ago. By default there is no cadence re-fetch:
    // the free breadcrumb trail + live tip carry the curve forward, so no credit
    // is re-spent on interior bars.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T13:35:00Z"), "100")] },
      fx: [],
      updatedAt: now.getTime() - 5 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      liveTip: { valueEur: d(1010), valueUsd: d(1110) },
    });
    // No credit spent, yet the curve's final value still advances to the live tip
    // at `now` — the free freshness the breadcrumb trail relies on.
    expect(fetchBars).not.toHaveBeenCalled();
    expect(result.points[result.points.length - 1]).toEqual({
      t: now.getTime(),
      valueEur: d(1010),
      valueUsd: d(1110),
    });
  });

  it("never re-buys bars on a long open watch while the breadcrumb trail stays fresh", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T14:00:00Z");
    // Bars are 2 hours old — a long open-browser watch — but the breadcrumb trail
    // has been laid the whole time (newest crumb seconds ago), so the data on the
    // device is current and there is still no bar pull: the point of breadcrumbs is
    // to use the data we have over re-buying near-identical bars.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T12:00:00Z"), "100")] },
      fx: [],
      tips: [{ t: now.getTime() - 30_000, valueEur: d(1010), valueUsd: d(1110) }],
      updatedAt: now.getTime() - 2 * 60 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it("repulls the whole session on resume when the freshest point has gone stale", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T16:00:00Z");
    // Logged in earlier, then left: the newest data on the device (both the bar
    // and the last breadcrumb) is ~2h old because refresh paused while away. On
    // logging back in, the default 10-minute resume window is blown, so the whole
    // session is re-pulled to bridge the dead span with real bars rather than a
    // single straight jump to the live tip.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T14:00:00Z"), "100")] },
      fx: [],
      tips: [{ t: now.getTime() - 2 * 60 * 60_000, valueEur: d(1010), valueUsd: d(1110) }],
      updatedAt: now.getTime() - 2 * 60 * 60_000,
    });
    const fetchBars = vi.fn(async () =>
      new Map<string, Bar[]>([["VTI", [bar(Date.parse("2026-06-23T19:55:00Z"), "100")]]]),
    );
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
    expect(fetchBars).toHaveBeenCalledOnce();
    // The resume repull grabs every symbol (best possible curve), not just gaps.
    expect(fetchBars).toHaveBeenCalledWith(["VTI"]);
  });

  it("does not resume-repull while the breadcrumb trail is younger than the window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T16:00:00Z");
    // Continuously open: the bars are old but the newest breadcrumb is only 5
    // minutes back (inside the 10-minute resume window), so nothing is re-pulled.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T12:00:00Z"), "100")] },
      fx: [],
      tips: [{ t: now.getTime() - 5 * 60_000, valueEur: d(1010), valueUsd: d(1110) }],
      updatedAt: now.getTime() - 4 * 60 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it("resumeBackfillMs=Infinity disables resume repull (pure breadcrumb mode)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T16:00:00Z");
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T12:00:00Z"), "100")] },
      fx: [],
      tips: [{ t: now.getTime() - 3 * 60 * 60_000, valueEur: d(1010), valueUsd: d(1110) }],
      updatedAt: now.getTime() - 4 * 60 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      resumeBackfillMs: Number.POSITIVE_INFINITY,
    });
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it("re-fetches open-market bars once a finite minRefetchMs window has elapsed", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T14:00:00Z");
    // Cache is 20 minutes old. Opting into a finite 15-minute cadence makes a
    // top-up due, so the bars are re-fetched.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T13:35:00Z"), "100")] },
      fx: [],
      updatedAt: now.getTime() - 20 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      minRefetchMs: 15 * 60_000,
    });
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

  it("carries an all-NAV (empty-sleeve) book on the live tip + breadcrumb trail", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const now = new Date("2026-06-23T14:00:00Z");
    // A book with no market-priced sleeve (all NAV funds + cash fold into the base).
    // Previously the 1D graph returned blank; now the whole-book line is carried by
    // the live tip, with the moving tip persisted as a breadcrumb for next build.
    const result = await loadOrBuildSessionCurve({
      anchor: { holdings: [], baseEur: d(5000), baseUsd: d(5500), baseFx: d("0.9") },
      store,
      fetchBars,
      now,
      liveTip: { valueEur: d(5000), valueUsd: d(5500) },
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(result.points).toEqual([{ t: now.getTime(), valueEur: d(5000), valueUsd: d(5500) }]);
    // The tip is persisted (base-tagged) so the trail thickens on later builds.
    const stored = await store.loadSession("2026-06-23");
    expect(stored!.tips).toHaveLength(1);
    expect(stored!.tips![0].baseEur!.toString()).toBe("5000");
  });

  it("persists each open-market breadcrumb tagged with the base it was struck against", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T14:00:00Z");
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T13:35:00Z"), "100")] },
      fx: [],
      updatedAt: now.getTime() - 5 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(), // base 100/100
      store,
      fetchBars,
      now,
      liveTip: { valueEur: d(1010), valueUsd: d(1110) },
    });
    const stored = await store.loadSession("2026-06-23");
    const crumb = stored!.tips![stored!.tips!.length - 1];
    expect(crumb.valueEur.toString()).toBe("1010"); // whole-book total
    expect(crumb.baseEur!.toString()).toBe("100"); // base it was struck at
    expect(crumb.baseUsd!.toString()).toBe("100");
  });

  it("rebases a stale breadcrumb trail onto the current base (NAV moved since)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    // A breadcrumb struck earlier at base 100 (whole-book 1050), after the last bar.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T15:00:00Z"), "100")] },
      fx: [],
      tips: [
        {
          t: Date.parse("2026-06-23T19:30:00Z"),
          valueEur: d(1050),
          valueUsd: d(1150),
          baseEur: d(100),
          baseUsd: d(100),
        },
      ],
      updatedAt: Date.parse("2026-06-23T19:30:00Z"),
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const now = new Date("2026-06-23T22:00:00Z"); // closed → renders stored trail
    // The NAV has since been re-struck: the current base is 300 (up 200).
    const anchor: IntradayAnchor = {
      holdings: [
        { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true },
      ],
      baseEur: d(300),
      baseUsd: d(300),
      baseFx: d("0.9"),
    };
    const result = await loadOrBuildSessionCurve({ anchor, store, fetchBars, now });
    // The trailing crumb rides the new base: 1050 − 100 + 300 = 1250 (not a flat
    // 1050 floor that would step off the rebased bar curve).
    const last = result.points[result.points.length - 1];
    expect(last.t).toBe(Date.parse("2026-06-23T19:30:00Z"));
    expect(last.valueEur.toString()).toBe("1250");
    expect(last.valueUsd.toString()).toBe("1350");
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

  it("back-fills a missing FX track without re-buying bars (secondary currency diverges)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    // Bars already on the device (price == close → ratio 1) but no FX track, the
    // exact self-fetched state where the rebased EUR line would otherwise collapse
    // onto USD. Market closed: bars must NOT be re-fetched, only the cheap FX.
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T15:00:00Z"), "100")] },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [bar(Date.parse("2026-06-23T15:00:00Z"), "1.0")]);
    const now = new Date("2026-06-23T22:00:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchFx,
      now,
    });
    // No bar pull (already loaded + closed), but the FX track is filled once.
    expect(fetchBars).not.toHaveBeenCalled();
    expect(fetchFx).toHaveBeenCalledOnce();
    // EUR rebased to the bar's rate (1.0) instead of the settled baseFx (0.9):
    // contrib = 900 · 0.9 / 1.0 = 810 ⇒ valueEur = base 100 + 810 = 910 (≠ 1000).
    expect(result.points).toHaveLength(1);
    expect(result.points[0].valueEur.toString()).toBe("910");
    // USD stays FX-free: base 100 + 1000 = 1100.
    expect(result.points[0].valueUsd.toString()).toBe("1100");
    // The refilled FX track is now persisted for next time.
    expect((await store.loadSession("2026-06-23"))?.fx).toHaveLength(1);
  });

  it("does not re-fire the FX refill when the track is already in hand (no autofire)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T15:00:00Z"), "100")] },
      fx: [bar(Date.parse("2026-06-23T15:00:00Z"), "1.0")],
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [bar(Date.parse("2026-06-23T15:00:00Z"), "1.0")]);
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchFx,
      now: new Date("2026-06-23T22:00:00Z"),
    });
    // Already loaded + closed + FX in hand: neither pipe fires.
    expect(fetchBars).not.toHaveBeenCalled();
    expect(fetchFx).not.toHaveBeenCalled();
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

  it("records a breadcrumb and self-thickens the curve between bar fetches", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T14:00:00Z");
    // A 5-minute-old session so the bars are reused (no fetch); the only way the
    // curve can gain interior detail is the breadcrumb trail.
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T13:35:00Z"), "100")] },
      fx: [],
      tips: [{ t: Date.parse("2026-06-23T13:50:00Z"), valueEur: d(1005), valueUsd: d(1105) }],
      updatedAt: now.getTime() - 5 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      liveTip: { valueEur: d(1010), valueUsd: d(1110) },
    });
    expect(fetchBars).not.toHaveBeenCalled();
    // bar point + the prior breadcrumb (interior) + the live tip at `now`.
    expect(result.points).toHaveLength(3);
    expect(result.points[1].valueEur).toEqual(d(1005)); // the gathered breadcrumb
    expect(result.points[2]).toEqual({ t: now.getTime(), valueEur: d(1010), valueUsd: d(1110) });
    // The moving tip is now itself persisted as a breadcrumb for the next build.
    const stored = await store.loadSession("2026-06-23");
    expect(stored!.tips!.map((p) => p.valueEur.toString())).toContain("1010");
    // …without bumping the bar-refetch throttle.
    expect(stored!.updatedAt).toBe(now.getTime() - 5 * 60_000);
  });

  it("hands freshly fetched bars to onFreshBars (quote write-back), not on reuse", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const onFreshBars = vi.fn();
    const freshBar = bar(Date.parse("2026-06-23T13:55:00Z"), "100");
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["VTI", [freshBar]]]));
    const now = new Date("2026-06-23T14:00:00Z");
    // Cold store → a real fetch happens, so onFreshBars fires with the bars.
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now, onFreshBars });
    expect(onFreshBars).toHaveBeenCalledOnce();
    expect(onFreshBars.mock.calls[0][0].get("VTI")).toEqual([freshBar]);

    // A second build 5 minutes later reuses the stored bars — no fetch, no callback.
    onFreshBars.mockClear();
    fetchBars.mockClear();
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now: new Date("2026-06-23T14:05:00Z"),
      onFreshBars,
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(onFreshBars).not.toHaveBeenCalled();
  });
});
