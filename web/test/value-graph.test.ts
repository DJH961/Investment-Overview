/**
 * Tests for the pure model↔live-curve glue (`value-graph.ts`). No DOM, no
 * IndexedDB, no live API — just the anchor split and the column flattening.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import { buildModelAnchor, curveColumns } from "../src/value-graph";
import type { HoldingView } from "../src/compute";
import type { CurvePoint } from "../src/timeseries";

const d = (v: string | number): Decimal => new Decimal(v);

/** A minimal HoldingView carrying only the fields buildModelAnchor reads. */
function holding(over: Partial<HoldingView>): HoldingView {
  return {
    symbol: "SYM",
    name: "Some name",
    assetClass: "etf",
    category: null,
    broker: "b",
    account: "a",
    nativeCurrency: "USD",
    priceType: "market",
    shares: d(10),
    priceNative: d(100),
    priceIsLive: true,
    priceMarketOpen: true,
    priceAsOf: null,
    pricePulledAt: null,
    priceFreshness: "aged",
    priceFallbackDate: "2024-06-03",
    valueIsStale: false,
    valueEur: d(1000),
    costBasisEur: null,
    todayMoveEur: null,
    todayMovePct: null,
    todayMoveIsStale: false,
    todayFxMoveEur: null,
    weight: null,
    unrealisedPlEur: null,
    totalGrowthPct: null,
    xirr: null,
    valueUsd: d(1080),
    costBasisUsd: null,
    todayMoveUsd: null,
    todayMovePctUsd: null,
    unrealisedPlUsd: null,
    totalGrowthPctUsd: null,
    xirrUsd: null,
    ...over,
  };
}

describe("buildModelAnchor", () => {
  it("keys the intraday sleeve by priceSymbol (not the display symbol)", () => {
    const anchor = buildModelAnchor(
      [holding({ symbol: "Vanguard S&P", priceSymbol: "VOO" })],
      d(0),
      d(0),
      d("1.08"),
    );
    expect(anchor.holdings).toHaveLength(1);
    expect(anchor.holdings[0].priceSymbol).toBe("VOO");
  });

  it("falls back to the display symbol when priceSymbol is unset", () => {
    const anchor = buildModelAnchor([holding({ symbol: "VOO", priceSymbol: undefined })], d(0), d(0), null);
    expect(anchor.holdings[0].priceSymbol).toBe("VOO");
  });

  it("folds NAV funds and cash into the flat base, keeping FX", () => {
    const anchor = buildModelAnchor(
      [
        holding({ priceSymbol: "VOO" }),
        holding({ priceSymbol: "FUND", priceType: "nav", valueEur: d(500), valueUsd: d(540) }),
      ],
      d(200),
      d(216),
      d("1.08"),
    );
    expect(anchor.holdings.map((h) => h.priceSymbol)).toEqual(["VOO"]);
    // base = cash + the NAV fund's value.
    expect(anchor.baseEur.toString()).toBe("700");
    expect(anchor.baseUsd.toString()).toBe("756");
    expect(anchor.baseFx?.toString()).toBe("1.08");
  });

  it("freezes the EUR view to graphFx for USD holdings, leaving USD FX-free", () => {
    // Live FX 1.08 (baseFx); freeze to the session-close 1.05. The USD leg is
    // unchanged ($1080) but the EUR leg is re-marked at the frozen rate:
    // 1080 / 1.05 = 1028.571…, not the live 1000.
    const anchor = buildModelAnchor(
      [holding({ priceSymbol: "VOO", nativeCurrency: "USD", valueEur: d(1000), valueUsd: d(1080) })],
      d(0),
      d(0),
      d("1.08"),
      { graphFx: d("1.05") },
    );
    expect(anchor.baseFx?.toString()).toBe("1.05");
    expect(anchor.holdings[0].valueUsd.toString()).toBe("1080");
    expect(anchor.holdings[0].valueEur.toNumber()).toBeCloseTo(1028.5714, 3);
  });

  it("re-derives the EUR cash sleeve's USD twin from graphFx", () => {
    const anchor = buildModelAnchor(
      [holding({ priceSymbol: "FUND", priceType: "nav", nativeCurrency: "EUR", valueEur: d(500), valueUsd: d(540) })],
      d(200),
      d(216),
      d("1.08"),
      { graphFx: d("1.05") },
    );
    // EUR-native NAV fund keeps its EUR value (500) and its USD value (540); the
    // cash USD twin is re-derived from graphFx (200 * 1.05 = 210), so the flat
    // base is 700 EUR / (210 + 540) = 750 USD at the frozen rate.
    expect(anchor.baseEur.toString()).toBe("700");
    expect(anchor.baseUsd.toString()).toBe("750");
    expect(anchor.baseFx?.toString()).toBe("1.05");
  });

  it("ignores a non-positive graphFx (keeps the live-FX EUR values)", () => {
    const anchor = buildModelAnchor(
      [holding({ priceSymbol: "VOO", valueEur: d(1000), valueUsd: d(1080) })],
      d(0),
      d(0),
      d("1.08"),
      { graphFx: d(0) },
    );
    expect(anchor.baseFx?.toString()).toBe("1.08");
    expect(anchor.holdings[0].valueEur.toString()).toBe("1000");
  });
});

describe("curveColumns", () => {
  it("flattens points into aligned ISO dates + per-currency values", () => {
    const points: CurvePoint[] = [
      { t: Date.parse("2026-06-23T13:30:00Z"), valueEur: d(1000), valueUsd: d(1080) },
      { t: Date.parse("2026-06-23T14:30:00Z"), valueEur: d(1010), valueUsd: d(1090) },
    ];
    const cols = curveColumns(points);
    expect(cols.dates).toEqual(["2026-06-23T13:30:00.000Z", "2026-06-23T14:30:00.000Z"]);
    expect(cols.eur.map((v) => v.toString())).toEqual(["1000", "1010"]);
    expect(cols.usd.map((v) => v.toString())).toEqual(["1080", "1090"]);
  });

  it("returns empty columns for an empty curve", () => {
    expect(curveColumns([])).toEqual({ dates: [], eur: [], usd: [] });
  });
});
