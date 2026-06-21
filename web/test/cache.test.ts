/**
 * Tests for the localStorage-backed cache + credit-log primitives.
 * Uses an in-memory Storage stub so nothing touches the real browser.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  creditsSpentWithin,
  readCachedFx,
  readCachedQuotes,
  readCreditLog,
  recordCredits,
  writeCachedFx,
  writeCachedQuotes,
  type StorageLike,
} from "../src/cache";
import type { Quote } from "../src/prices";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function quote(symbol: string, price: string | null, prev: string | null = null, ccy = "USD"): Quote {
  return {
    symbol,
    price: price === null ? null : new Decimal(price),
    previousClose: prev === null ? null : new Decimal(prev),
    currency: ccy,
  };
}

describe("quote cache", () => {
  it("round-trips a quote with its timestamp", () => {
    const s = memStorage();
    writeCachedQuotes(new Map([["VTI", quote("VTI", "100.5", "99")]]), 1000, s);
    const got = readCachedQuotes(s).get("VTI")!;
    expect(got.at).toBe(1000);
    expect(got.quote.price?.toString()).toBe("100.5");
    expect(got.quote.previousClose?.toString()).toBe("99");
    expect(got.quote.currency).toBe("USD");
  });

  it("does not store a null-price quote (keeps the prior good value)", () => {
    const s = memStorage();
    writeCachedQuotes(new Map([["VTI", quote("VTI", "100")]]), 1000, s);
    writeCachedQuotes(new Map([["VTI", quote("VTI", null)]]), 2000, s);
    const got = readCachedQuotes(s).get("VTI")!;
    expect(got.quote.price?.toString()).toBe("100");
    expect(got.at).toBe(1000);
  });

  it("returns an empty map for missing/corrupt cache", () => {
    const s = memStorage();
    expect(readCachedQuotes(s).size).toBe(0);
    s.setItem("iv.web.quote_cache", "not json");
    expect(readCachedQuotes(s).size).toBe(0);
  });
});

describe("fx cache", () => {
  it("round-trips rates and timestamp", () => {
    const s = memStorage();
    writeCachedFx({ base: "EUR", rates: { USD: new Decimal("1.1") } }, 500, s);
    const got = readCachedFx(s)!;
    expect(got.at).toBe(500);
    expect(got.fx.rates.USD.toString()).toBe("1.1");
  });
});

describe("credit log", () => {
  it("accumulates spends and sums within a window", () => {
    const s = memStorage();
    recordCredits(3, 1000, s);
    recordCredits(2, 2000, s);
    const log = readCreditLog(2500, 24 * 60 * 60 * 1000, s);
    expect(creditsSpentWithin(log, 2500, 60 * 1000)).toBe(5);
    // Only the second spend is within a 1s window ending at 2500.
    expect(creditsSpentWithin(log, 2500, 1000)).toBe(2);
  });

  it("prunes entries older than the keep window on read", () => {
    const s = memStorage();
    recordCredits(5, 0, s);
    const dayMs = 24 * 60 * 60 * 1000;
    const log = readCreditLog(dayMs + 1, dayMs, s);
    expect(log.length).toBe(0);
  });

  it("ignores non-positive spends", () => {
    const s = memStorage();
    recordCredits(0, 1000, s);
    expect(readCreditLog(1000, 60_000, s).length).toBe(0);
  });
});
