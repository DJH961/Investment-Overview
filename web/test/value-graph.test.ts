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
    priceIsCurrent: false,
    priceFallbackDate: "2024-06-03",
    valueIsStale: false,
    valueEur: d(1000),
    costBasisEur: null,
    todayMoveEur: null,
    todayMovePct: null,
    todayMoveIsStale: false,
    todayFxMoveEur: null,
    priorCloseValueEur: null,
    priorCloseValueUsd: null,
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

describe("market-closed freeze invariant (1D/1W STAY PUT on the close FX)", () => {
  // Locks the cross-currency contract the live 1D/1W graphs must honour once the
  // equity session has shut but FX still trades:
  //   - the **USD** leg is FX-free, so the frozen (market-closed) curve and the
  //     live (market-open) curve carry the *identical* USD value. The 1D graph's
  //     USD growth therefore equals the overview's "today" USD move by
  //     construction — neither involves FX.
  //   - the **EUR** leg of the frozen curve is re-marked at the session-close FX
  //     (`graphFx`), so once the rate drifts overnight it diverges from the live
  //     EUR view (which keeps tracking the live spot on the headline / 1M+
  //     graphs). They reconcile only while the close rate still equals the live
  //     rate.
  const usd = holding({ priceSymbol: "VOO", nativeCurrency: "USD", valueEur: d(1000), valueUsd: d(1080) });

  it("keeps the USD leg identical whether frozen at close or live (FX-free)", () => {
    const live = buildModelAnchor([usd], d(0), d(0), d("1.08"));
    const frozen = buildModelAnchor([usd], d(0), d(0), d("1.08"), { graphFx: d("1.05") });
    // The 1D/1W USD curve does not move when the EUR view freezes — it is the
    // same native-USD total the overview values "today" from.
    expect(frozen.holdings[0].valueUsd.toString()).toBe(live.holdings[0].valueUsd.toString());
    expect(frozen.holdings[0].valueUsd.toString()).toBe("1080");
  });

  it("diverges the EUR leg once the close FX differs from the live FX", () => {
    const live = buildModelAnchor([usd], d(0), d(0), d("1.08"));
    const frozen = buildModelAnchor([usd], d(0), d(0), d("1.08"), { graphFx: d("1.05") });
    // Live EUR tracks the live spot (1080 / 1.08 = 1000); the frozen EUR is
    // re-marked at the close (1080 / 1.05 = 1028.57…), so the EUR lines part.
    expect(live.holdings[0].valueEur.toString()).toBe("1000");
    expect(frozen.holdings[0].valueEur.toNumber()).toBeCloseTo(1028.5714, 3);
    expect(frozen.holdings[0].valueEur.equals(live.holdings[0].valueEur)).toBe(false);
  });

  it("reconciles the EUR leg when the close FX still equals the live FX", () => {
    // The "unless FX rate stays the same" clause: a flat overnight rate leaves the
    // frozen and live EUR views identical.
    const live = buildModelAnchor([usd], d(0), d(0), d("1.08"));
    const frozen = buildModelAnchor([usd], d(0), d(0), d("1.08"), { graphFx: d("1.08") });
    expect(frozen.holdings[0].valueEur.toString()).toBe(live.holdings[0].valueEur.toString());
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
