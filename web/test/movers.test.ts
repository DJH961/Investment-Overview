import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import { buildMovers } from "../src/compute";
import type { HoldingView } from "../src/compute";

/** Override knobs for the test holding (numbers are coerced to Decimal). */
interface Over {
  symbol: string;
  name?: string;
  assetClass?: string;
  valueEur?: number | null;
  todayMoveEur?: number | null;
  todayMovePct?: number | null;
  todayMoveUsd?: number | null;
  todayMovePctUsd?: number | null;
  todayMoveIsStale?: boolean;
  priceFallbackDate?: string;
}

/** A minimal HoldingView carrying only the fields buildMovers reads. */
function holding(over: Over): HoldingView {
  const num = (v: number | null | undefined): Decimal | null =>
    v === null || v === undefined ? null : new Decimal(v);
  return {
    symbol: over.symbol,
    name: over.name ?? over.symbol,
    assetClass: over.assetClass ?? "etf",
    category: null,
    broker: "b",
    account: "a",
    nativeCurrency: "EUR",
    priceType: "market",
    shares: new Decimal(0),
    priceNative: new Decimal(1),
    priceIsLive: false,
    priceMarketOpen: null,
    priceAsOf: null,
    priceFallbackDate: over.priceFallbackDate ?? "2024-06-03",
    valueIsStale: false,
    valueEur: num(over.valueEur) ?? new Decimal(1000),
    costBasisEur: null,
    todayMoveEur: num(over.todayMoveEur),
    todayMovePct: num(over.todayMovePct),
    todayMoveIsStale: over.todayMoveIsStale ?? false,
    todayFxMoveEur: null,
    weight: null,
    unrealisedPlEur: null,
    totalGrowthPct: null,
    xirr: null,
    valueUsd: null,
    costBasisUsd: null,
    todayMoveUsd: num(over.todayMoveUsd),
    todayMovePctUsd: num(over.todayMovePctUsd),
    unrealisedPlUsd: null,
    totalGrowthPctUsd: null,
    xirrUsd: null,
  };
}

describe("buildMovers", () => {
  it("returns the biggest money and biggest percentage mover on each side", () => {
    const movers = buildMovers([
      // Big money winner but modest %.
      holding({ symbol: "AAA", todayMoveEur: 500, todayMovePct: 0.01 }),
      // Big % winner but modest money.
      holding({ symbol: "BBB", todayMoveEur: 50, todayMovePct: 0.08 }),
      // Big money loser, modest %.
      holding({ symbol: "CCC", todayMoveEur: -400, todayMovePct: -0.02 }),
      // Big % loser, modest money.
      holding({ symbol: "DDD", todayMoveEur: -20, todayMovePct: -0.09 }),
    ]);
    expect(movers.winners.map((w) => [w.symbol, w.reason])).toEqual([
      ["AAA", "total"],
      ["BBB", "percent"],
    ]);
    expect(movers.losers.map((l) => [l.symbol, l.reason])).toEqual([
      ["CCC", "total"],
      ["DDD", "percent"],
    ]);
    expect(movers.eligibleCount).toBe(4);
    expect(movers.basisDate).toBe("2024-06-03");
  });

  it("substitutes the percentage runner-up when one holding tops both money and %", () => {
    const movers = buildMovers([
      // Tops both money and % among winners.
      holding({ symbol: "TOP", todayMoveEur: 900, todayMovePct: 0.1 }),
      // Percentage runner-up.
      holding({ symbol: "RUN", todayMoveEur: 100, todayMovePct: 0.05 }),
      holding({ symbol: "LOW", todayMoveEur: 80, todayMovePct: 0.01 }),
    ]);
    expect(movers.winners.map((w) => [w.symbol, w.reason])).toEqual([
      ["TOP", "total"],
      ["RUN", "percent"],
    ]);
    expect(movers.losers).toHaveLength(0);
  });

  it("excludes lagging holdings (not repriced on the freshest date)", () => {
    const movers = buildMovers([
      holding({ symbol: "LIVE", todayMoveEur: 300, todayMovePct: 0.03 }),
      // A fund still on yesterday's NAV — should not appear among today's movers.
      holding({
        symbol: "LAG",
        todayMoveEur: 999,
        todayMovePct: 0.5,
        todayMoveIsStale: true,
        priceFallbackDate: "2024-06-02",
      }),
    ]);
    expect(movers.winners.map((w) => w.symbol)).toEqual(["LIVE"]);
    expect(movers.eligibleCount).toBe(1);
    expect(movers.basisDate).toBe("2024-06-03");
  });

  it("ignores holdings without a today's move and yields empty sides when flat", () => {
    const movers = buildMovers([
      holding({ symbol: "NONE", todayMoveEur: null, todayMovePct: null }),
    ]);
    expect(movers.winners).toHaveLength(0);
    expect(movers.losers).toHaveLength(0);
    expect(movers.eligibleCount).toBe(0);
    expect(movers.basisDate).toBeNull();
  });

  it("shows a single entry when only one mover exists on a side", () => {
    const movers = buildMovers([
      holding({ symbol: "ONLY", todayMoveEur: 200, todayMovePct: 0.02 }),
      holding({ symbol: "DOWN", todayMoveEur: -10, todayMovePct: -0.001 }),
    ]);
    expect(movers.winners.map((w) => w.symbol)).toEqual(["ONLY"]);
    expect(movers.losers.map((l) => l.symbol)).toEqual(["DOWN"]);
  });
});
