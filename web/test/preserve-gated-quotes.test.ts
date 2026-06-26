import { describe, expect, it } from "vitest";

import { preserveCachedQuotesForGatedLegs } from "../src/app";
import { Decimal } from "../src/decimal-config";
import type { Quote } from "../src/prices";
import type { CachedQuote } from "../src/cache";

function quote(symbol: string, price: number | null, valueDate: string | null, at = 1_000): Quote {
  return {
    symbol,
    price: price === null ? null : new Decimal(price),
    previousClose: null,
    currency: "USD",
    at,
    priceTime: null,
    valueDate,
    marketOpen: false,
  };
}

function cached(quote: Quote): CachedQuote {
  return { quote, at: quote.at ?? 0 };
}

describe("preserveCachedQuotesForGatedLegs", () => {
  it("seeds a gated-off NAV from cache so it doesn't revert to the export value", () => {
    // The round only painted a market symbol (NAV leg was held); the NAV's
    // genuine current quote still lives in the cache.
    const painted = new Map<string, Quote>([["AAPL", quote("AAPL", 200, "2025-06-26")]]);
    const cache = new Map<string, CachedQuote>([
      ["AAPL", cached(quote("AAPL", 200, "2025-06-26"))],
      ["FSKAX", cached(quote("FSKAX", 175, "2025-06-25"))],
    ]);

    preserveCachedQuotesForGatedLegs(painted, ["AAPL", "FSKAX"], cache);

    expect(painted.get("FSKAX")?.valueDate).toBe("2025-06-25");
    expect(painted.get("FSKAX")?.price?.toString()).toBe("175");
  });

  it("never overwrites a quote the round actually produced", () => {
    const fresh = quote("FSKAX", 180, "2025-06-26", 9_000);
    const painted = new Map<string, Quote>([["FSKAX", fresh]]);
    const cache = new Map<string, CachedQuote>([
      ["FSKAX", cached(quote("FSKAX", 175, "2025-06-25", 1_000))],
    ]);

    preserveCachedQuotesForGatedLegs(painted, ["FSKAX"], cache);

    // The fresher round value wins; the older cached one must not clobber it.
    expect(painted.get("FSKAX")).toBe(fresh);
    expect(painted.get("FSKAX")?.valueDate).toBe("2025-06-26");
  });

  it("skips symbols with no priced cache entry", () => {
    const painted = new Map<string, Quote>();
    const cache = new Map<string, CachedQuote>([
      ["MISSING", cached(quote("MISSING", null, null))],
    ]);

    preserveCachedQuotesForGatedLegs(painted, ["MISSING", "ABSENT"], cache);

    expect(painted.has("MISSING")).toBe(false);
    expect(painted.has("ABSENT")).toBe(false);
  });

  it("ignores empty symbols", () => {
    const painted = new Map<string, Quote>();
    preserveCachedQuotesForGatedLegs(painted, [""], new Map());
    expect(painted.size).toBe(0);
  });
});
