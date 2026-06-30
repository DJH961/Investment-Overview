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
  clampFromOpen,
  intradaySymbols,
  loadOrBuildSessionCurve,
  marketSleeveSymbols,
  mergeBreadcrumbs,
  rebaseBreadcrumbs,
  type AnchorHoldingInput,
  type IntradayAnchor,
} from "../src/intraday";
import type { Bar, CurvePoint } from "../src/timeseries";
import { memoryBackend, TimeSeriesStore, type Breadcrumb, type StoredCloseProbe } from "../src/timeseries-store";
import { FX_PROBE_KEY } from "../src/close-completeness";

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

  it("folds NAV funds into the week sleeve (priceType nav) when navInSleeve is set", () => {
    const anchor = buildIntradayAnchor(
      [
        holding({ priceSymbol: "VTI" }),
        holding({ priceSymbol: "FXAIX", priceType: "nav", valueEur: d(50), valueUsd: d(55) }),
      ],
      d(100),
      d(110),
      d("0.9"),
      { navInSleeve: true },
    );
    // Both the market ETF and the priced NAV fund now sit in the sleeve...
    expect(anchor.holdings.map((h) => h.priceSymbol)).toEqual(["VTI", "FXAIX"]);
    expect(anchor.holdings.map((h) => h.priceType)).toEqual(["market", "nav"]);
    // ...so the fund's value is no longer double-counted in the flat base.
    expect(anchor.baseEur.toString()).toBe("100");
    expect(anchor.baseUsd.toString()).toBe("110");
  });

  it("keeps an unpriced NAV fund in the base even with navInSleeve set", () => {
    const anchor = buildIntradayAnchor(
      [holding({ priceSymbol: "VMFXX", priceType: "nav", priceNative: null, valueEur: d(50), valueUsd: d(50) })],
      d(0),
      d(0),
      null,
      { navInSleeve: true },
    );
    expect(anchor.holdings).toHaveLength(0);
    expect(anchor.baseEur.toString()).toBe("50");
  });
});

describe("marketSleeveSymbols", () => {
  it("returns only the market sleeve members (NAV funds excluded from fetch)", () => {
    const anchor = buildIntradayAnchor(
      [
        holding({ priceSymbol: "VTI" }),
        holding({ priceSymbol: "FXAIX", priceType: "nav", valueEur: d(50), valueUsd: d(55) }),
      ],
      d(0),
      d(0),
      d("0.9"),
      { navInSleeve: true },
    );
    expect(intradaySymbols(anchor)).toEqual(["VTI", "FXAIX"]);
    expect(marketSleeveSymbols(anchor)).toEqual(["VTI"]);
  });
});

describe("intradaySymbols", () => {
  it("returns the distinct tickers of the sleeve", () => {
    const anchor: IntradayAnchor = {
      holdings: [
        { priceSymbol: "VTI", valueEur: d(1), valueUsd: d(1), closeNative: d(1), isUsdNative: true, priceType: "market" },
        { priceSymbol: "VTI", valueEur: d(1), valueUsd: d(1), closeNative: d(1), isUsdNative: true, priceType: "market" },
        { priceSymbol: "QQQ", valueEur: d(1), valueUsd: d(1), closeNative: d(1), isUsdNative: true, priceType: "market" },
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

describe("clampFromOpen", () => {
  const points: CurvePoint[] = [
    { t: 100, valueEur: d(1), valueUsd: d(1) },
    { t: 200, valueEur: d(2), valueUsd: d(2) },
    { t: 300, valueEur: d(3), valueUsd: d(3) },
  ];

  it("drops points before the open", () => {
    expect(clampFromOpen(points, 200).map((p) => p.t)).toEqual([200, 300]);
  });

  it("returns the curve untouched rather than blanking it", () => {
    expect(clampFromOpen(points, 400)).toBe(points);
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
        { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true, priceType: "market" },
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

  it("clamps prior-day bars out of the stored session and the curve (1D = one day)", async () => {
    // Twelve Data's primary fetch (fixed bar count, no start_date) over-reaches:
    // early in Tuesday's session it hands back bars from Monday plus today's.
    const store = new TimeSeriesStore(memoryBackend());
    const fetchBars = vi.fn(async () =>
      new Map<string, Bar[]>([
        [
          "VTI",
          [
            bar(Date.parse("2026-06-22T15:00:00Z"), "80"), // Monday — must be dropped
            bar(Date.parse("2026-06-22T19:00:00Z"), "85"), // Monday — must be dropped
            bar(Date.parse("2026-06-23T13:35:00Z"), "90"), // Tuesday open
            bar(Date.parse("2026-06-23T14:00:00Z"), "95"), // Tuesday
          ],
        ],
      ]),
    );
    // Tue 2026-06-23 14:05 UTC == 10:05 ET, early in the session.
    const now = new Date("2026-06-23T14:05:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      liveTip: null,
    });

    // The store must only retain Tuesday's bars, so the cache never accumulates
    // cross-day bars across the session.
    const session = await store.loadSession("2026-06-23");
    expect(session?.bars.VTI?.map((b) => b.t)).toEqual([
      Date.parse("2026-06-23T13:35:00Z"),
      Date.parse("2026-06-23T14:00:00Z"),
    ]);
    // The reconstructed curve starts at Tuesday's open, never Monday.
    expect(result.points.every((p) => p.t >= Date.parse("2026-06-23T13:30:00Z"))).toBe(true);
  });

  it("defensively clamps cross-day bars already in the cache from a pre-fix build", async () => {
    // A session persisted before the store-side filter existed still holds a
    // prior-day bar; the render-side clamp keeps it out of the drawn curve.
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2026-06-23", {
      bars: {
        VTI: [
          bar(Date.parse("2026-06-22T15:00:00Z"), "80"), // Monday — defensively dropped
          bar(Date.parse("2026-06-23T13:35:00Z"), "90"), // Tuesday open
          bar(Date.parse("2026-06-23T15:00:00Z"), "100"), // Tuesday
        ],
      },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    // After the close: Tue 2026-06-23 22:00 UTC == 18:00 ET.
    const now = new Date("2026-06-23T22:00:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      liveTip: null,
    });
    expect(result.points.every((p) => p.t >= Date.parse("2026-06-23T13:30:00Z"))).toBe(true);
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
    // A bar reaching the session close (19:30Z == 15:30 ET, within a bar interval
    // of the 16:00 ET close) — a genuinely complete day, so nothing to re-fetch.
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T19:30:00Z"), "100")] },
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

  it("pins a reloaded closed-market curve to the settled headline tip at the close", async () => {
    // A reload after the close rebuilds from stored bars (the springboard is
    // skipped). If those bars reconstruct to a total that disagrees with the
    // settled headline — short / budget-deferred symbols carried flat — the curve
    // must still END on the headline, so the "% today" it measures matches the
    // headline growth rather than drifting (the reload total/growth bug).
    const store = new TimeSeriesStore(memoryBackend());
    // A bar reaching the close (19:55Z) but priced 90 ⇒ reconstruction USD =
    // 100 + 1000·(90/100) = 1000, deliberately below the settled headline 1100.
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T19:55:00Z"), "90")] },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const now = new Date("2026-06-23T22:00:00Z"); // 18:00 ET, after close
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
      liveTip: { valueEur: d(1010), valueUsd: d(1100) },
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(result.marketOpen).toBe(false);
    // The reconstructed body keeps its shape, but the final point is the settled
    // headline pinned at the close — not the drifted reconstruction endpoint.
    const last = result.points[result.points.length - 1];
    expect(last.valueUsd.toString()).toBe("1100");
    expect(last.valueEur.toString()).toBe("1010");
    expect(last.t).toBeGreaterThan(Date.parse("2026-06-23T19:55:00Z"));
  });

  it("re-fetches a stale partial-day session after the close to complete the tail (scenario F)", async () => {    const store = new TimeSeriesStore(memoryBackend());
    // A session whose stored bars stop at 14:00 ET (18:00Z) — an earlier
    // mid-session fetch that was never completed. It *looks* present, but never
    // reached the 16:00 ET close, so after the close it must be re-pulled.
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T18:00:00Z"), "100")] },
    });
    // The completing fetch returns the full session, including the close tail.
    const fetchBars = vi.fn(async () =>
      new Map<string, Bar[]>([
        [
          "VTI",
          [bar(Date.parse("2026-06-23T18:00:00Z"), "100"), bar(Date.parse("2026-06-23T19:55:00Z"), "110")],
        ],
      ]),
    );
    // After the close: Tue 2026-06-23 22:00 UTC == 18:00 ET.
    const now = new Date("2026-06-23T22:00:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now,
    });
    expect(fetchBars).toHaveBeenCalledWith(["VTI"]);
    // The tail bar is now part of the curve, so it runs to the close, not 14:00.
    expect(result.points).toHaveLength(2);
    expect(result.points[result.points.length - 1].t).toBe(Date.parse("2026-06-23T19:55:00Z"));
  });

  it("reports sleeve coverage — full when every symbol has bars, partial when some are flat", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    // A two-symbol sleeve where only VTI has bars; VXUS is carried flat.
    const anchor: IntradayAnchor = {
      holdings: [
        { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true, priceType: "market" },
        { priceSymbol: "VXUS", valueEur: d(450), valueUsd: d(500), closeNative: d(50), isUsdNative: true, priceType: "market" },
      ],
      baseEur: d(100),
      baseUsd: d(100),
      baseFx: d("0.9"),
    };
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T19:55:00Z"), "100")] },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>()); // feed returns nothing for VXUS
    const now = new Date("2026-06-23T22:00:00Z");
    const result = await loadOrBuildSessionCurve({ anchor, store, fetchBars, now });
    expect(result.coverage).toEqual({ covered: 1, total: 2 });
  });

  it("reports full coverage when the single sleeve symbol has bars", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T19:55:00Z"), "100")] },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const now = new Date("2026-06-23T22:00:00Z");
    const result = await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
    expect(result.coverage).toEqual({ covered: 1, total: 1 });
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

  it("does not resume-repull a stale-but-present session (clock-hour gate is the sole 1D authority)", async () => {
    // Resume-backfill is deleted (docs/centralized_data_pull_plan.md): a re-login
    // or long absence whose freshest point has aged well past the old 10-minute
    // window must NOT force a second, hour-conflicting bar pull while the session's
    // bars are already on the device. Breadcrumbs bridge the gap until the next
    // clock hour, which the orchestrator owns.
    const store = new TimeSeriesStore(memoryBackend());
    const now = new Date("2026-06-23T16:00:00Z");
    await store.saveSession({
      day: "2026-06-23",
      bars: { VTI: [bar(Date.parse("2026-06-23T12:00:00Z"), "100")] },
      fx: [],
      tips: [{ t: now.getTime() - 2 * 60 * 60_000, valueEur: d(1010), valueUsd: d(1110) }],
      updatedAt: now.getTime() - 2 * 60 * 60_000,
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now });
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
        { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true, priceType: "market" },
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
    // onto USD. Market closed: bars must NOT be re-fetched, only the cheap FX. The
    // bar reaches the session close (19:30Z == 15:30 ET) so it counts as complete.
    await store.mergeSession("2026-06-23", {
      bars: { VTI: [bar(Date.parse("2026-06-23T19:30:00Z"), "100")] },
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
      bars: { VTI: [bar(Date.parse("2026-06-23T19:30:00Z"), "100")] },
      fx: [bar(Date.parse("2026-06-23T19:30:00Z"), "1.0")],
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

describe("loadOrBuildSessionCurve — regenerateOnly seam (Pillar 6)", () => {
  function anchor(): IntradayAnchor {
    return {
      holdings: [
        { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true, priceType: "market" },
      ],
      baseEur: d(100),
      baseUsd: d(100),
      baseFx: d("0.9"),
    };
  }

  it("never fetches bars when regenerateOnly is set, even mid-session with missing symbols", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [] as Bar[]);
    // Mid-session, store empty (would normally cold-fetch): regenerate-only forbids it.
    const now = new Date("2026-06-23T15:00:00Z");
    const result = await loadOrBuildSessionCurve({
      anchor: anchor(),
      store,
      fetchBars,
      fetchFx,
      now,
      regenerateOnly: true,
      liveTip: { valueEur: d(1010), valueUsd: d(1110) },
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(fetchFx).not.toHaveBeenCalled();
    // Pure reconstruct still pins the live tip so the curve isn't blank.
    expect(result.points.length).toBeGreaterThanOrEqual(1);
  });

  it("reconstructs from already-stored bars without a network call", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    // Seed the store via a normal fetching build first.
    const seedBars = vi.fn(async () =>
      new Map<string, Bar[]>([["VTI", [bar(Date.parse("2026-06-23T13:35:00Z"), "90")]]]),
    );
    const seedNow = new Date("2026-06-23T14:00:00Z");
    await loadOrBuildSessionCurve({ anchor: anchor(), store, fetchBars: seedBars, now: seedNow });
    expect(seedBars).toHaveBeenCalledOnce();

    // A regenerate-only rebuild must reuse the stored bars and fetch nothing.
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const result = await loadOrBuildSessionCurve({
      anchor: anchor(),
      store,
      fetchBars,
      now: new Date("2026-06-23T15:00:00Z"),
      regenerateOnly: true,
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(result.points.length).toBeGreaterThanOrEqual(1);
  });
});

describe("loadOrBuildSessionCurve — multi-provider close completeness (C2–C7)", () => {
  // The 2026-06-23 regular session closes at 16:00 ET == 20:00Z. INTRADAY_BAR_
  // INTERVAL_MS is one hour, so a bar at/after 19:00Z reads "reached close".
  const CLOSE_Z = Date.parse("2026-06-23T20:00:00Z");
  const T1400 = Date.parse("2026-06-23T18:00:00Z"); // 14:00 ET — short of close
  const T1530 = Date.parse("2026-06-23T19:30:00Z"); // 15:30 ET — reaches close
  const NOW_CLOSED = new Date("2026-06-23T22:00:00Z"); // 18:00 ET, after close

  function singleEtfAnchor(): IntradayAnchor {
    return {
      holdings: [
        { priceSymbol: "DAX", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true, priceType: "market" },
      ],
      baseEur: d(100),
      baseUsd: d(100),
      baseFx: d("0.9"),
    };
  }

  async function seedShort(store: TimeSeriesStore): Promise<void> {
    // A present-but-short stored session: last bar at 14:00 ET, never reached close.
    await store.mergeSession("2026-06-23", { bars: { DAX: [bar(T1400, "100")] } });
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

  it("C2: a settled symbol is excluded from the missing set (zero fetches)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    await store.mergeSession("2026-06-23", {
      closeProbe: {
        DAX: { lastBarAt: T1400, attempts: 1, sources: 2, settled: true, lastAttemptAt: 1 },
      },
    });
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now: NOW_CLOSED });
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it("C2: an unsettled short symbol is still fetched", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now: NOW_CLOSED });
    expect(fetchBars).toHaveBeenCalledWith(["DAX"]);
  });

  it("C3 illiquid: two providers must agree 3× (hour-paced) before the close settles, then 0", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    const fetchSecondaryBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    const log: { outcome: string; level: string; message: string }[] = [];
    const build = (now: Date): Promise<unknown> =>
      loadOrBuildSessionCurve({
        anchor: singleEtfAnchor(),
        store,
        fetchBars,
        fetchSecondaryBars,
        now,
        formatInstant: (t) => (t === CLOSE_Z ? "16:00 ET" : new Date(t).toISOString()),
        onCloseResolve: (e) => log.push(e),
      });
    const probeNow = async (): Promise<StoredCloseProbe> =>
      (await store.loadSession("2026-06-23"))!.closeProbe!.DAX;

    // Agreement #1 at 22:00Z — provisional only: both agree, but the close is not
    // yet accepted (sources:2, settled:false).
    await build(NOW_CLOSED);
    expect(fetchBars).toHaveBeenCalledTimes(1);
    expect(fetchSecondaryBars).toHaveBeenCalledTimes(1);
    let probe = await probeNow();
    expect(probe.settled).toBe(false);
    expect(probe.sources).toBe(2);
    expect(probe.agreements).toBe(1);

    // A redraw before the next full hour is held flat (hourly pacing, no credits).
    fetchBars.mockClear();
    fetchSecondaryBars.mockClear();
    await build(new Date(NOW_CLOSED.getTime() + 5 * 60_000)); // 22:05Z < 23:00Z
    expect(fetchBars).not.toHaveBeenCalled();
    expect(fetchSecondaryBars).not.toHaveBeenCalled();

    // Agreement #2 at the top of the next hour (23:00Z) — still provisional.
    await build(new Date(Date.parse("2026-06-23T23:00:00Z")));
    probe = await probeNow();
    expect(probe.settled).toBe(false);
    expect(probe.agreements).toBe(2);

    // Agreement #3 at the following hour (00:00Z, still the 23 Jun ET session) ⇒
    // settled for the day.
    await build(new Date(Date.parse("2026-06-24T00:00:00Z")));
    probe = await probeNow();
    expect(probe.settled).toBe(true);
    expect(probe.sources).toBe(2);
    expect(probe.agreements).toBe(3);
    expect(log.some((l) => l.outcome === "settled-by-agreement" && l.level === "good")).toBe(true);
    // C6: the line is human-facing — it names the symbol, the 1D label, and uses
    // the injected instant formatter (no raw epoch ms leaks into the trail).
    const settledLine = log.find((l) => l.outcome === "settled-by-agreement")!;
    expect(settledLine.message).toContain("1D graph · DAX");
    expect(settledLine.message).not.toMatch(/\d{10,}/);

    // Next build: settled ⇒ no further fetches.
    fetchBars.mockClear();
    fetchSecondaryBars.mockClear();
    await build(new Date(Date.parse("2026-06-24T01:00:00Z")));
    expect(fetchBars).not.toHaveBeenCalled();
    expect(fetchSecondaryBars).not.toHaveBeenCalled();
  });

  it("C3 logged-off-early: the primary now reaches the close ⇒ reached-close, no escalation", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100"), bar(T1530, "110")]]]));
    const fetchSecondaryBars = vi.fn(async () => new Map<string, Bar[]>());
    const log: { outcome: string; level: string; message: string }[] = [];
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchSecondaryBars,
      now: NOW_CLOSED,
      onCloseResolve: (e) => log.push(e),
    });
    expect(fetchSecondaryBars).not.toHaveBeenCalled();
    const session = (await store.loadSession("2026-06-23"))!;
    expect(session.closeProbe).toBeUndefined(); // cleared
    expect(session.bars.DAX.some((b) => b.t === T1530)).toBe(true);
    expect(log.some((l) => l.outcome === "reached-close" && l.level === "good")).toBe(true);
  });

  it("C3 weak-on-primary: the secondary supplies the close ⇒ reached-close via secondary", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    const fetchSecondaryBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1530, "110")]]]));
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchSecondaryBars,
      now: NOW_CLOSED,
    });
    expect(fetchSecondaryBars).toHaveBeenCalledTimes(1);
    const session = (await store.loadSession("2026-06-23"))!;
    expect(session.bars.DAX.some((b) => b.t === T1530)).toBe(true);
    expect(session.closeProbe).toBeUndefined(); // reached-close clears the probe
  });

  it("C3 outage: both providers empty ⇒ not settled, back-off struck", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchSecondaryBars = vi.fn(async () => new Map<string, Bar[]>());
    const backoff = fakeBackoff();
    const log: { outcome: string; level: string; message: string }[] = [];
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchSecondaryBars,
      closeBackoff: backoff,
      now: NOW_CLOSED,
      onCloseResolve: (e) => log.push(e),
    });
    const probe = (await store.loadSession("2026-06-23"))!.closeProbe!.DAX;
    expect(probe.settled).toBe(false);
    expect(backoff.fails.get("close:1D:DAX")).toBe(1);
    expect(log.some((l) => l.outcome === "deferred-outage" && l.level === "warn")).toBe(true);
  });

  it("C3 tolerance (P5): a bar that only moves seconds reads as no-advance ⇒ escalates", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    // Primary returns a bar 40s later than the stored tip — noise, not progress.
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400 + 40_000, "100")]]]));
    const fetchSecondaryBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400 + 40_000, "100")]]]));
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchSecondaryBars,
      now: NOW_CLOSED,
    });
    // It escalated (no false progress) and the two sources agreed ⇒ a provisional
    // agreement is recorded (sources:2), pending the hour-paced re-confirmations.
    expect(fetchSecondaryBars).toHaveBeenCalledTimes(1);
    const probe = (await store.loadSession("2026-06-23"))!.closeProbe!.DAX;
    expect(probe.sources).toBe(2);
    expect(probe.settled).toBe(false);
    expect(probe.agreements).toBe(1);
  });

  it("C4 spacing gate: repeated builds 1s apart probe at most once per window", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    // No secondary ⇒ the short symbol never settles, but the spacing gate must
    // still stop the per-render hammer.
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now: NOW_CLOSED });
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now: new Date(NOW_CLOSED.getTime() + 1000),
    });
    expect(fetchBars).toHaveBeenCalledTimes(1); // second build held flat by the gate
  });

  it("C4 spacing gate: a build past the spacing window probes again", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, now: NOW_CLOSED });
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      now: new Date(NOW_CLOSED.getTime() + 11 * 60_000),
    });
    expect(fetchBars).toHaveBeenCalledTimes(2);
  });

  it("C4: a suppressed (armed cooldown) short symbol is not probed", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    const backoff = fakeBackoff();
    backoff.armed.add("close:1D:DAX");
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      closeBackoff: backoff,
      now: NOW_CLOSED,
    });
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it("C3: a settled probe survives an app restart (persisted in the store)", async () => {
    const backend = memoryBackend();
    const store = new TimeSeriesStore(backend);
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    const fetchSecondaryBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1400, "100")]]]));
    await loadOrBuildSessionCurve({ anchor: singleEtfAnchor(), store, fetchBars, fetchSecondaryBars, now: NOW_CLOSED });
    // A "restart": a brand-new store over the same backend.
    const store2 = new TimeSeriesStore(backend);
    fetchBars.mockClear();
    fetchSecondaryBars.mockClear();
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store: store2,
      fetchBars,
      fetchSecondaryBars,
      now: new Date(NOW_CLOSED.getTime() + 30 * 60_000),
    });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(fetchSecondaryBars).not.toHaveBeenCalled();
  });

  it("C7 liquid: a symbol with a closing bar settles with 0 escalations", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedShort(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>([["DAX", [bar(T1530, "110")]]]));
    const fetchSecondaryBars = vi.fn(async () => new Map<string, Bar[]>());
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchSecondaryBars,
      now: NOW_CLOSED,
    });
    expect(fetchBars).toHaveBeenCalledTimes(1);
    expect(fetchSecondaryBars).not.toHaveBeenCalled();
  });

  // ── FX-track parity (new requirement): the EUR/USD track settles to its best
  // close exactly like a price symbol, and a per-render redraw never re-pulls it.
  async function seedCompleteBarsIncompleteFx(store: TimeSeriesStore): Promise<void> {
    // The price bars already reach the close (so prices never gate the FX work),
    // but the FX track stops at 14:00 ET — short of the 15:00 ET reached-close floor.
    await store.mergeSession("2026-06-23", {
      bars: { DAX: [bar(T1530, "110")] },
      fx: [bar(T1400, "1.00")],
    });
  }

  it("FX C5: an incomplete-but-present FX track is advanced to its settled close, then not re-pulled", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedCompleteBarsIncompleteFx(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [bar(T1530, "1.10")]); // reaches the close
    const log: { symbol: string; outcome: string; level: string }[] = [];
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchFx,
      now: NOW_CLOSED,
      onCloseResolve: (e) => log.push(e),
    });
    expect(fetchBars).not.toHaveBeenCalled(); // prices already complete
    expect(fetchFx).toHaveBeenCalledTimes(1);
    const session = (await store.loadSession("2026-06-23"))!;
    expect(session.fx.some((b) => b.t === T1530)).toBe(true);
    expect(session.closeProbe?.[FX_PROBE_KEY]).toBeUndefined(); // reached-close clears it
    expect(log.some((l) => l.symbol === FX_PROBE_KEY && l.outcome === "reached-close")).toBe(true);

    // A second build: the FX track now reaches the close ⇒ no further FX pull.
    fetchFx.mockClear();
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchFx,
      now: new Date(NOW_CLOSED.getTime() + 60 * 60_000),
    });
    expect(fetchFx).not.toHaveBeenCalled();
  });

  it("FX C5: two providers must agree 3× (hour-paced) before the day's FX settles (sources=2)", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedCompleteBarsIncompleteFx(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [bar(T1400, "1.00")]); // no advance vs stored tip
    const fetchSecondaryFx = vi.fn(async () => [bar(T1400, "1.00")]); // agrees
    const build = (now: Date): Promise<unknown> =>
      loadOrBuildSessionCurve({
        anchor: singleEtfAnchor(),
        store,
        fetchBars,
        fetchFx,
        fetchSecondaryFx,
        now,
      });
    const fxProbe = async (): Promise<StoredCloseProbe> =>
      (await store.loadSession("2026-06-23"))!.closeProbe![FX_PROBE_KEY];

    // Agreement #1 at 22:00Z — provisional (sources:2, settled:false).
    await build(NOW_CLOSED);
    expect(fetchFx).toHaveBeenCalledTimes(1);
    expect(fetchSecondaryFx).toHaveBeenCalledTimes(1);
    expect((await fxProbe()).settled).toBe(false);
    expect((await fxProbe()).agreements).toBe(1);

    // A redraw before the next full hour is held flat (hourly pacing).
    fetchFx.mockClear();
    fetchSecondaryFx.mockClear();
    await build(new Date(NOW_CLOSED.getTime() + 5 * 60_000)); // 22:05Z
    expect(fetchFx).not.toHaveBeenCalled();

    // Agreements #2 (23:00Z) and #3 (00:00Z) ⇒ settled on the third.
    await build(new Date(Date.parse("2026-06-23T23:00:00Z")));
    expect((await fxProbe()).agreements).toBe(2);
    await build(new Date(Date.parse("2026-06-24T00:00:00Z")));
    const probe = await fxProbe();
    expect(probe.settled).toBe(true);
    expect(probe.sources).toBe(2);
    expect(probe.agreements).toBe(3);

    // Settled ⇒ neither FX provider is asked again on a redraw.
    fetchFx.mockClear();
    fetchSecondaryFx.mockClear();
    await build(new Date(Date.parse("2026-06-24T01:00:00Z")));
    expect(fetchFx).not.toHaveBeenCalled();
    expect(fetchSecondaryFx).not.toHaveBeenCalled();
  });

  it("FX C5: an FX outage strikes the back-off under the FX key, never settling", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedCompleteBarsIncompleteFx(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [] as Bar[]);
    const fetchSecondaryFx = vi.fn(async () => [] as Bar[]);
    const backoff = fakeBackoff();
    const log: { symbol: string; outcome: string; level: string }[] = [];
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchFx,
      fetchSecondaryFx,
      closeBackoff: backoff,
      now: NOW_CLOSED,
      onCloseResolve: (e) => log.push(e),
    });
    const probe = (await store.loadSession("2026-06-23"))!.closeProbe![FX_PROBE_KEY];
    expect(probe.settled).toBe(false);
    expect(backoff.fails.get(`close:1D:${FX_PROBE_KEY}`)).toBe(1);
    expect(log.some((l) => l.symbol === FX_PROBE_KEY && l.outcome === "deferred-outage")).toBe(true);
  });

  it("FX C5: regenerate-only never pulls the FX track even when it is incomplete", async () => {
    const store = new TimeSeriesStore(memoryBackend());
    await seedCompleteBarsIncompleteFx(store);
    const fetchBars = vi.fn(async () => new Map<string, Bar[]>());
    const fetchFx = vi.fn(async () => [bar(T1530, "1.10")]);
    await loadOrBuildSessionCurve({
      anchor: singleEtfAnchor(),
      store,
      fetchBars,
      fetchFx,
      regenerateOnly: true,
      now: NOW_CLOSED,
    });
    expect(fetchFx).not.toHaveBeenCalled();
  });
});
