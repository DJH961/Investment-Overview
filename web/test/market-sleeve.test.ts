import { describe, expect, it } from "vitest";
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
  rebaseSleeveToWholeBook,
  type SleevePoint,
} from "../src/market-sleeve";
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

  it("exposes the documented default tolerance", () => {
    expect(DEFAULT_RECON_TAU).toBe(0.0025);
  });
});
