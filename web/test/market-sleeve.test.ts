import { describe, expect, it, vi } from "vitest";
import { Decimal } from "../src/decimal-config";
import {
  DEFAULT_GRID_MS,
  DEFAULT_RECON_TAU,
  bucketStart,
  describeFlag,
  describeMerge,
  gridMsFor,
  hasMarketSleeve,
  mergeSleeveSeries,
  parseMarketSeries,
  parseMoneyMarketValue,
  moneyMarketValueOnDate,
  aggregateMoneyMarketValue,
  pinMergedTipToWebTip,
  rebaseSleeveToWholeBook,
  type SleevePoint,
} from "../src/market-sleeve";
import type { CurvePoint } from "../src/timeseries";
import type { ExportLiveGraphs, ExportMarketSeries } from "../src/types";

const T0 = Date.parse("2026-06-22T13:30:00Z");
const STEP = DEFAULT_GRID_MS;

function sleeve(tOffsetBuckets: number, value: string, fx: string | null = "1.08"): SleevePoint {
  return {
    t: T0 + tOffsetBuckets * STEP + 3 * 60 * 1000, // 3 min into the bucket (true ts)
    valueNativeUsd: new Decimal(value),
    fxEurUsd: fx === null ? null : new Decimal(fx),
  };
}

describe("parseMarketSeries", () => {
  it("zips the columnar arrays, skips gaps, preserves null FX", () => {
    const series: ExportMarketSeries = {
      times: ["2026-06-22T13:30:00Z", "2026-06-22T14:00:00Z", "2026-06-22T14:30:00Z"],
      value_native: ["10000.00", null, "10100.00"],
      fx_eur_usd: ["1.08", "1.08", null],
    };
    const points = parseMarketSeries(series);
    expect(points).toHaveLength(2); // the null value is a gap, skipped
    expect(points[0].valueNativeUsd.toString()).toBe("10000");
    expect(points[0].fxEurUsd?.toString()).toBe("1.08");
    expect(points[1].fxEurUsd).toBeNull(); // null FX preserved for today's-rate fallback
  });

  it("returns [] for absent/empty/garbage series (graceful degradation)", () => {
    expect(parseMarketSeries(undefined)).toEqual([]);
    expect(parseMarketSeries(null)).toEqual([]);
    expect(parseMarketSeries({ times: [], value_native: [], fx_eur_usd: [] })).toEqual([]);
    expect(
      parseMarketSeries({ times: ["nope"], value_native: ["x"], fx_eur_usd: ["y"] }),
    ).toEqual([]);
  });

  it("drops non-positive FX to null rather than dividing by it later", () => {
    const points = parseMarketSeries({
      times: ["2026-06-22T13:30:00Z"],
      value_native: ["100"],
      fx_eur_usd: ["0"],
    });
    expect(points[0].fxEurUsd).toBeNull();
  });
});

describe("bucketStart / gridMsFor", () => {
  it("floors to the grid bucket", () => {
    expect(bucketStart(T0 + 3 * 60 * 1000, STEP)).toBe(T0);
    expect(bucketStart(T0 + STEP + 60 * 1000, STEP)).toBe(T0 + STEP);
  });
  it("maps the export grid tag to ms", () => {
    expect(gridMsFor("30m")).toBe(30 * 60 * 1000);
    expect(gridMsFor("15m")).toBe(15 * 60 * 1000);
    expect(gridMsFor(undefined)).toBe(DEFAULT_GRID_MS);
  });
  it("warns and defaults to 30m for an unrecognised grid tag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Cast: a runtime-only garbled/future tag the static type forbids.
      expect(gridMsFor("5m" as unknown as Parameters<typeof gridMsFor>[0])).toBe(DEFAULT_GRID_MS);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("mergeSleeveSeries", () => {
  it("uses the only present source per slot", () => {
    const web = [sleeve(0, "100")];
    const blob = [sleeve(1, "200")];
    const merged = mergeSleeveSeries(web, blob);
    expect(merged.points.map((p) => p.source)).toEqual(["web", "blob"]);
    expect(merged.counts).toEqual({ web: 1, blob: 1, both: 0 });
    expect(merged.flags).toHaveLength(0);
  });

  it("keeps the denser union (thickens) when both agree within tau", () => {
    const web = [sleeve(0, "10000.00")];
    const blob = [sleeve(0, "10010.00")]; // 0.1% < 0.25% tau
    const merged = mergeSleeveSeries(web, blob);
    expect(merged.counts.both).toBe(1);
    expect(merged.points).toHaveLength(2); // union of both → richer line
    expect(merged.points.every((p) => p.source === "both")).toBe(true);
    expect(merged.flags).toHaveLength(0);
  });

  it("keeps the blob and flags when both disagree beyond tau", () => {
    const web = [sleeve(0, "10000.00")];
    const blob = [sleeve(0, "11000.00")]; // 10% >> tau
    const merged = mergeSleeveSeries(web, blob);
    expect(merged.points).toHaveLength(1);
    expect(merged.points[0].source).toBe("blob");
    expect(merged.points[0].valueNativeUsd.toString()).toBe("11000");
    expect(merged.flags).toHaveLength(1);
    expect(merged.flags[0].deltaFraction).toBeCloseTo((10000 - 11000) / 11000, 6);
  });

  it("respects a custom tau", () => {
    const web = [sleeve(0, "100")];
    const blob = [sleeve(0, "101")]; // 1%
    expect(mergeSleeveSeries(web, blob, { tau: 0.02 }).flags).toHaveLength(0);
    expect(mergeSleeveSeries(web, blob, { tau: 0.005 }).flags).toHaveLength(1);
  });

  it("keeps true timestamps (grid is comparison-only, never snapping)", () => {
    const web = [sleeve(0, "100")];
    const merged = mergeSleeveSeries(web, []);
    expect(merged.points[0].t).toBe(T0 + 3 * 60 * 1000); // 13:33, not snapped to 13:30
  });

  it("sorts the merged line ascending across many slots", () => {
    const web = [sleeve(2, "102"), sleeve(0, "100")];
    const blob = [sleeve(1, "101"), sleeve(3, "103")];
    const merged = mergeSleeveSeries(web, blob);
    const ts = merged.points.map((p) => p.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});

describe("rebaseSleeveToWholeBook", () => {
  it("adds the base; USD is FX-free, EUR uses the per-instant rate", () => {
    const points: SleevePoint[] = [sleeve(0, "10000", "1.25")];
    const [p] = rebaseSleeveToWholeBook(
      points,
      { baseEur: new Decimal("1000"), baseUsd: new Decimal("1200") },
      new Decimal("1.10"),
    );
    expect(p.valueUsd.toString()).toBe("11200"); // 10000 + 1200, no FX
    expect(p.valueEur.toString()).toBe("9000"); // 10000/1.25 + 1000
  });

  it("falls back to today's FX when a point shipped none", () => {
    const points: SleevePoint[] = [sleeve(0, "10000", null)];
    const [p] = rebaseSleeveToWholeBook(
      points,
      { baseEur: new Decimal("0"), baseUsd: new Decimal("0") },
      new Decimal("2"),
    );
    expect(p.valueEur.toString()).toBe("5000"); // 10000 / 2 fallback
  });

  it("keeps the USD line complete even with no FX at all (EUR at parity)", () => {
    const points: SleevePoint[] = [sleeve(0, "10000", null)];
    const [p] = rebaseSleeveToWholeBook(
      points,
      { baseEur: new Decimal("0"), baseUsd: new Decimal("0") },
      null,
    );
    expect(p.valueUsd.toString()).toBe("10000");
    expect(p.valueEur.toString()).toBe("10000");
  });
});

describe("pinMergedTipToWebTip", () => {
  const curve = (t: number, usd: string, eur: string): CurvePoint => ({
    t,
    valueUsd: new Decimal(usd),
    valueEur: new Decimal(eur),
  });
  const webTip = curve(T0 + 5 * STEP, "10500", "9800");

  it("drops a blob sample stamped past the web tip and pins the tip (no nosedive)", () => {
    const merged = [
      curve(T0 + 4 * STEP, "10400", "9700"),
      webTip,
      // A stale/partial blob sleeve sample captured a minute past the tip — the
      // exact "final-minute nosedive" the guard exists to stop.
      curve(T0 + 5 * STEP + 60_000, "9800", "9750"),
    ];
    const pinned = pinMergedTipToWebTip(merged, webTip);
    expect(pinned).toHaveLength(2);
    const last = pinned[pinned.length - 1];
    expect(last).toBe(webTip);
    expect(last.valueUsd.toString()).toBe("10500"); // trusted tip, not the dip
  });

  it("replaces a diving blob sample sharing the tip's instant with the trusted tip", () => {
    const merged = [
      curve(T0 + 4 * STEP, "10400", "9700"),
      // Same instant as the web tip but a low blob value — dropped by `< t`.
      curve(T0 + 5 * STEP, "9800", "9750"),
    ];
    const pinned = pinMergedTipToWebTip(merged, webTip);
    expect(pinned[pinned.length - 1]).toBe(webTip);
    expect(pinned.map((p) => p.t)).toEqual([T0 + 4 * STEP, T0 + 5 * STEP]);
  });

  it("is a no-op when the merged curve already ends at the web tip", () => {
    const body = curve(T0 + 4 * STEP, "10400", "9700");
    const pinned = pinMergedTipToWebTip([body, webTip], webTip);
    expect(pinned).toEqual([body, webTip]);
  });

  it("preserves the densified body before the tip", () => {
    const a = curve(T0 + 2 * STEP, "10200", "9500");
    const b = curve(T0 + 3 * STEP, "10300", "9600");
    const c = curve(T0 + 4 * STEP, "10400", "9700");
    const pinned = pinMergedTipToWebTip([a, b, c], webTip);
    expect(pinned).toEqual([a, b, c, webTip]);
  });
});

describe("hasMarketSleeve / describers", () => {
  it("detects a usable v3 backbone and degrades on v2", () => {
    const v2: ExportLiveGraphs = { captured_at: "2026-06-22T20:00:00Z" };
    const v3: ExportLiveGraphs = {
      captured_at: "2026-06-22T20:00:00Z",
      market_series: {
        times: ["2026-06-22T13:30:00Z", "2026-06-22T14:00:00Z"],
        value_native: ["100", "101"],
        fx_eur_usd: ["1.08", "1.08"],
      },
    };
    expect(hasMarketSleeve(v2)).toBe(false);
    expect(hasMarketSleeve(undefined)).toBe(false);
    expect(hasMarketSleeve(v3)).toBe(true);
  });

  it("describeMerge and describeFlag are log-ready", () => {
    const web = [sleeve(0, "10000")];
    const blob = [sleeve(0, "11000")];
    const merged = mergeSleeveSeries(web, blob);
    expect(describeMerge(merged)).toContain("1 reconciliation flag");
    expect(describeFlag(merged.flags[0])).toMatch(/Δ/);
  });

  it("describeFlag renders a non-finite delta (zero blob value) as ∞, not Infinity%", () => {
    const web = [sleeve(0, "10000")];
    const blob = [sleeve(0, "0")];
    const merged = mergeSleeveSeries(web, blob);
    expect(merged.flags).toHaveLength(1);
    expect(merged.flags[0].deltaFraction).toBe(Number.POSITIVE_INFINITY);
    const line = describeFlag(merged.flags[0]);
    expect(line).toContain("(Δ ∞)");
    expect(line).not.toContain("Infinity");
  });

  it("exposes the documented default tolerance", () => {
    expect(DEFAULT_RECON_TAU).toBe(0.0025);
  });

  it("parses per-fund money-market value, ascending and gap-tolerant", () => {
    const exported = {
      mm_value_native: {
        VMFXX: [
          ["2026-06-23", "6000.00"],
          ["2026-06-22", "5000.00"],
          ["2026-06-21", null],
        ],
      },
    } as unknown as ExportLiveGraphs;
    const parsed = parseMoneyMarketValue(exported);
    const days = parsed.get("VMFXX");
    expect(days?.map((d) => d.date)).toEqual(["2026-06-22", "2026-06-23"]);
    expect(days?.[1].valueNativeUsd.toFixed(0)).toBe("6000");
  });

  it("money-market value on a date is the latest balance at or before it (never a future deposit)", () => {
    const days = parseMoneyMarketValue({
      mm_value_native: { VMFXX: [["2026-06-22", "5000"], ["2026-06-23", "9000"]] },
    } as unknown as ExportLiveGraphs).get("VMFXX")!;
    expect(moneyMarketValueOnDate(days, "2026-06-22")?.toFixed(0)).toBe("5000");
    expect(moneyMarketValueOnDate(days, "2026-06-23")?.toFixed(0)).toBe("9000");
    expect(moneyMarketValueOnDate(days, "2026-06-20")).toBeNull();
  });

  it("money-market parse is absent-tolerant for legacy/v2 exports", () => {
    expect(parseMoneyMarketValue(undefined).size).toBe(0);
    expect(parseMoneyMarketValue({} as ExportLiveGraphs).size).toBe(0);
  });

  it("aggregates per-fund money-market value into one whole-book USD/day, carrying funds flat", () => {
    const series = parseMoneyMarketValue({
      mm_value_native: {
        VMFXX: [["2026-06-22", "5000"], ["2026-06-24", "9000"]],
        SPAXX: [["2026-06-23", "1000"]],
      },
    } as unknown as ExportLiveGraphs);
    const agg = aggregateMoneyMarketValue(series);
    // Union of dates; each absent fund contributes its last known balance (or 0).
    expect(agg.map((d) => d.date)).toEqual(["2026-06-22", "2026-06-23", "2026-06-24"]);
    expect(agg[0].valueNativeUsd.toFixed(0)).toBe("5000"); // VMFXX only
    expect(agg[1].valueNativeUsd.toFixed(0)).toBe("6000"); // VMFXX 5000 + SPAXX 1000
    expect(agg[2].valueNativeUsd.toFixed(0)).toBe("10000"); // VMFXX 9000 + SPAXX 1000
  });

  it("aggregate is empty for an export without money-market funds", () => {
    expect(aggregateMoneyMarketValue(parseMoneyMarketValue(undefined))).toEqual([]);
  });
});
