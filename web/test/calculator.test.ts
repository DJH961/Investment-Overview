import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import { buildCalculatorData, UNCATEGORIZED } from "../src/calculator";
import type { HoldingView } from "../src/compute";
import type { ExportTargetAllocation } from "../src/types";

/** A minimal HoldingView with only the fields the calculator reads. */
function holding(over: Partial<HoldingView> & { symbol: string }): HoldingView {
  return {
    symbol: over.symbol,
    name: over.name ?? over.symbol,
    assetClass: over.assetClass ?? "etf",
    category: over.category ?? null,
    broker: "b",
    account: "a",
    nativeCurrency: "EUR",
    priceType: "market",
    shares: over.shares ?? new Decimal(0),
    priceNative: null,
    priceIsLive: false,
    priceAsOf: null,
    priceFallbackDate: "2024-01-01",
    valueIsStale: false,
    valueEur: over.valueEur ?? null,
    costBasisEur: null,
    todayMoveEur: null,
    todayMovePct: null,
    todayFxMoveEur: null,
    weight: null,
    unrealisedPlEur: null,
    totalGrowthPct: null,
    xirr: null,
    valueUsd: null,
    costBasisUsd: null,
    todayMoveUsd: null,
    todayMovePctUsd: null,
    unrealisedPlUsd: null,
    totalGrowthPctUsd: null,
    xirrUsd: null,
  };
}

describe("buildCalculatorData", () => {
  it("aggregates holdings by symbol and computes current weights", () => {
    const data = buildCalculatorData([
      holding({ symbol: "VTI", valueEur: new Decimal(600), shares: new Decimal(6) }),
      holding({ symbol: "VTI", valueEur: new Decimal(150), shares: new Decimal(1.5) }),
      holding({ symbol: "BND", valueEur: new Decimal(250), shares: new Decimal(5), assetClass: "bond" }),
    ]);
    expect(data.totalValueEur.toString()).toBe("1000");
    const bySymbol = new Map(data.instruments.map((i) => [i.symbol, i]));
    expect(bySymbol.get("VTI")!.currentValueEur.toString()).toBe("750");
    expect(bySymbol.get("VTI")!.currentPct.toString()).toBe("75");
    expect(bySymbol.get("BND")!.currentPct.toString()).toBe("25");
    // Derived EUR price = aggregated value / aggregated shares.
    expect(bySymbol.get("VTI")!.priceEur!.toString()).toBe("100");
  });

  it("falls back category → humanised asset_class → Uncategorized", () => {
    const data = buildCalculatorData([
      holding({ symbol: "A", category: "US Stocks", valueEur: new Decimal(10), shares: new Decimal(1) }),
      holding({ symbol: "B", category: null, assetClass: "bond", valueEur: new Decimal(10), shares: new Decimal(1) }),
      holding({ symbol: "C", category: null, assetClass: "", valueEur: new Decimal(10), shares: new Decimal(1) }),
      holding({ symbol: "D", category: null, assetClass: "money_market", valueEur: new Decimal(10), shares: new Decimal(1) }),
    ]);
    const bySymbol = new Map(data.instruments.map((i) => [i.symbol, i]));
    // An explicit main-app category always wins.
    expect(bySymbol.get("A")!.category).toBe("US Stocks");
    // Raw asset-class slugs read as friendly category labels.
    expect(bySymbol.get("B")!.category).toBe("Bonds");
    expect(bySymbol.get("D")!.category).toBe("Money market");
    // Nothing to fall back to ⇒ Uncategorized.
    expect(bySymbol.get("C")!.category).toBe(UNCATEGORIZED);
  });

  it("groups members into categories sorted heaviest-first", () => {
    const data = buildCalculatorData([
      holding({ symbol: "A", category: "Small", valueEur: new Decimal(100), shares: new Decimal(1) }),
      holding({ symbol: "B", category: "Big", valueEur: new Decimal(900), shares: new Decimal(1) }),
    ]);
    expect(data.categories.map((c) => c.name)).toEqual(["Big", "Small"]);
    expect(data.categories[0].currentPct.toString()).toBe("90");
    expect(data.categories[0].members[0].symbol).toBe("B");
  });

  it("gives a null price when a symbol has no value", () => {
    const data = buildCalculatorData([
      holding({ symbol: "X", valueEur: null, shares: new Decimal(5) }),
    ]);
    expect(data.instruments[0].priceEur).toBeNull();
    expect(data.instruments[0].currentValueEur.toString()).toBe("0");
  });

  it("maps saved target allocations from the export blob", () => {
    const saved: ExportTargetAllocation[] = [
      {
        name: "Core",
        active: true,
        allow_sell: true,
        display_currency: "USD",
        items: [
          { instrument_id: 1, symbol: "VTI", weight_pct: "70", no_buy: false },
          { instrument_id: 2, symbol: "BND", weight_pct: "30", no_buy: true },
        ],
      },
    ];
    const data = buildCalculatorData(
      [holding({ symbol: "VTI", valueEur: new Decimal(10), shares: new Decimal(1) })],
      saved,
    );
    expect(data.savedTargets).toHaveLength(1);
    const t = data.savedTargets[0];
    expect(t.name).toBe("Core");
    expect(t.allowSell).toBe(true);
    expect(t.displayCurrency).toBe("USD");
    expect(t.items[0].weightPct.toString()).toBe("70");
    expect(t.items[1].noBuy).toBe(true);
  });
});
