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
    pricePulledAt: null,
    priceFreshness: "aged",
    priceIsCurrent: false,
    priceFallbackDate: over.priceFallbackDate ?? "2024-06-03",
    valueIsStale: false,
    valueEur: num(over.valueEur) ?? new Decimal(1000),
    costBasisEur: null,
    todayMoveEur: num(over.todayMoveEur),
    todayMovePct: num(over.todayMovePct),
    todayMoveIsStale: over.todayMoveIsStale ?? false,
    todayFxMoveEur: null,
    priorCloseValueEur: null,
    priorCloseValueUsd: null,
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

  it("includes a mutual fund once its NAV refreshes to the freshest date", () => {
    // A mutual fund lags on yesterday's NAV first (stale → ignored), then prints
    // today's NAV (not stale → must join the leaderboard like any other holding).
    const lagging = buildMovers([
      holding({ symbol: "ETF", todayMoveEur: 100, todayMovePct: 0.01 }),
      holding({
        symbol: "FUND",
        assetClass: "mutual_fund",
        todayMoveEur: 800,
        todayMovePct: 0.4,
        todayMoveIsStale: true,
        priceFallbackDate: "2024-06-02",
      }),
    ]);
    expect(lagging.winners.map((w) => w.symbol)).toEqual(["ETF"]);

    const refreshed = buildMovers([
      holding({ symbol: "ETF", todayMoveEur: 100, todayMovePct: 0.01 }),
      holding({
        symbol: "FUND",
        assetClass: "mutual_fund",
        todayMoveEur: 800,
        todayMovePct: 0.4,
        todayMoveIsStale: false,
        priceFallbackDate: "2024-06-03",
      }),
    ]);
    expect(refreshed.winners.map((w) => [w.symbol, w.reason])).toEqual([
      ["FUND", "total"],
      ["ETF", "percent"],
    ]);
    expect(refreshed.eligibleCount).toBe(2);
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

  it("ranks the top-% pick in the requested display currency", () => {
    // AAA is the bigger % gainer in EUR; BBB is the bigger % gainer in USD.
    const holdings = [
      holding({ symbol: "BIG", todayMoveEur: 900, todayMovePct: 0.01, todayMovePctUsd: 0.01 }),
      holding({ symbol: "AAA", todayMoveEur: 50, todayMovePct: 0.08, todayMovePctUsd: 0.03 }),
      holding({ symbol: "BBB", todayMoveEur: 40, todayMovePct: 0.05, todayMovePctUsd: 0.09 }),
    ];
    expect(buildMovers(holdings, "EUR").winners.map((w) => w.symbol)).toEqual(["BIG", "AAA"]);
    expect(buildMovers(holdings, "USD").winners.map((w) => w.symbol)).toEqual(["BIG", "BBB"]);
  });

  it("dates the board off the moves, not a fresher no-move price (stale/cold start)", () => {
    // A holding can be flagged `todayMoveIsStale` because some *other* row carries
    // a fresher price while itself contributing no move (e.g. a par-NAV money
    // market that always sits on today). The leaderboard must ignore that global
    // flag and date itself off the freshest holding that actually moved, so a cold
    // book of last-session moves on one shared older date still shows.
    const movers = buildMovers([
      holding({
        symbol: "AAA",
        todayMoveEur: 300,
        todayMovePct: 0.03,
        todayMoveIsStale: true,
        priceFallbackDate: "2024-06-02",
      }),
      holding({
        symbol: "BBB",
        todayMoveEur: -120,
        todayMovePct: -0.02,
        todayMoveIsStale: true,
        priceFallbackDate: "2024-06-02",
      }),
    ]);
    expect(movers.winners.map((w) => w.symbol)).toEqual(["AAA"]);
    expect(movers.losers.map((l) => l.symbol)).toEqual(["BBB"]);
    expect(movers.basisDate).toBe("2024-06-02");
    expect(movers.eligibleCount).toBe(2);
  });
});
