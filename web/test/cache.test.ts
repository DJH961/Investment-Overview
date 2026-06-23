/**
 * Tests for the localStorage-backed cache + credit-log primitives.
 * Uses an in-memory Storage stub so nothing touches the real browser.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  creditsSpentWithin,
  creditsSpentToday,
  startOfUtcDay,
  readCachedEnvelope,
  readCachedEurUsd,
  readCachedFx,
  readCachedQuotes,
  readCreditLog,
  readNavPublishStats,
  readSymbolPlan,
  recordCredits,
  recordNavPublish,
  writeCachedEnvelope,
  writeCachedEurUsd,
  writeCachedFx,
  writeCachedQuotes,
  writeSymbolPlan,
  clearPriceCaches,
  NAV_PUBLISH_SAMPLES,
  type StorageLike,
} from "../src/cache";
import type { Envelope } from "../src/crypto";
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

  it("persists the price's real strike time (priceTime) across the cache", () => {
    const s = memStorage();
    const q: Quote = {
      symbol: "FXAIX",
      price: new Decimal("101"),
      previousClose: null,
      currency: "USD",
      priceTime: 1_717_000_000_000,
      valueDate: "2024-05-31",
    };
    writeCachedQuotes(new Map([["FXAIX", q]]), 5000, s);
    const got = readCachedQuotes(s).get("FXAIX")!;
    // The fetch time and the price's own strike time are distinct and both kept.
    expect(got.at).toBe(5000);
    expect(got.quote.priceTime).toBe(1_717_000_000_000);
    expect(got.quote.valueDate).toBe("2024-05-31");
  });

  it("persists the provider market-state flag (marketOpen) across the cache", () => {
    const s = memStorage();
    const q: Quote = {
      symbol: "VTI",
      price: new Decimal("100"),
      previousClose: null,
      currency: "USD",
      marketOpen: false,
    };
    writeCachedQuotes(new Map([["VTI", q]]), 5000, s);
    expect(readCachedQuotes(s).get("VTI")!.quote.marketOpen).toBe(false);
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

  it("counts the daily budget from UTC midnight, not a rolling 24h window", () => {
    const s = memStorage();
    const DAY = 24 * 60 * 60 * 1000;
    // Two spends late "yesterday" (UTC) and one early "today".
    const yesterdayEvening = 5 * DAY - 2 * 60 * 60 * 1000; // 22:00 UTC, day 4
    const yesterdayLate = 5 * DAY - 30 * 60 * 1000; // 23:30 UTC, day 4
    const todayMorning = 5 * DAY + 6 * 60 * 60 * 1000; // 06:00 UTC, day 5
    recordCredits(300, yesterdayEvening, s);
    recordCredits(200, yesterdayLate, s);
    recordCredits(40, todayMorning, s);
    const log = readCreditLog(todayMorning, DAY, s);
    // A rolling 24h window would wrongly include yesterday's 500 credits...
    expect(creditsSpentWithin(log, todayMorning, DAY)).toBe(540);
    // ...but the UTC-day reset means only today's 40 count against the cap.
    expect(creditsSpentToday(log, todayMorning)).toBe(40);
  });

  it("startOfUtcDay lands exactly on the most recent UTC midnight", () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(startOfUtcDay(5 * DAY)).toBe(5 * DAY); // already midnight
    expect(startOfUtcDay(5 * DAY + 1)).toBe(5 * DAY); // 1ms past midnight
    expect(startOfUtcDay(6 * DAY - 1)).toBe(5 * DAY); // 1ms before next midnight
  });
});

describe("learned NAV publish stats", () => {
  // Local-time constructor keeps the derived hour timezone-independent.
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime();

  it("records the local hour a new value-date is first seen", () => {
    const s = memStorage();
    recordNavPublish("IE00FUND", "2024-01-10", at(2024, 0, 10, 22, 15), s);
    const stat = readNavPublishStats(s).get("IE00FUND");
    expect(stat?.lastValueDate).toBe("2024-01-10");
    expect(stat?.hours).toEqual([22.25]);
  });

  it("appends a new value-date but ignores repeats of one already held", () => {
    const s = memStorage();
    recordNavPublish("IE00FUND", "2024-01-10", at(2024, 0, 10, 22, 0), s);
    // Same value-date seen again later the same day — not a fresh publish.
    recordNavPublish("IE00FUND", "2024-01-10", at(2024, 0, 10, 23, 30), s);
    recordNavPublish("IE00FUND", "2024-01-11", at(2024, 0, 11, 22, 30), s);
    // An out-of-order older value-date is ignored too.
    recordNavPublish("IE00FUND", "2024-01-09", at(2024, 0, 9, 21, 0), s);
    const stat = readNavPublishStats(s).get("IE00FUND");
    expect(stat?.lastValueDate).toBe("2024-01-11");
    expect(stat?.hours).toEqual([22, 22.5]);
  });

  it("keeps only the most recent samples", () => {
    const s = memStorage();
    for (let i = 0; i < NAV_PUBLISH_SAMPLES + 5; i++) {
      const day = 1 + i;
      recordNavPublish("IE00FUND", `2024-02-${`${day}`.padStart(2, "0")}`, at(2024, 1, day, 22, 0), s);
    }
    const stat = readNavPublishStats(s).get("IE00FUND");
    expect(stat?.hours.length).toBe(NAV_PUBLISH_SAMPLES);
  });

  it("ignores empty symbols / value-dates and survives a corrupt store", () => {
    const s = memStorage();
    recordNavPublish("", "2024-01-10", at(2024, 0, 10, 22, 0), s);
    recordNavPublish("IE00FUND", "", at(2024, 0, 10, 22, 0), s);
    expect(readNavPublishStats(s).size).toBe(0);
    s.setItem("iv.web.nav_publish", "{ not json");
    expect(readNavPublishStats(s).size).toBe(0);
  });
});

describe("encrypted-blob cache", () => {
  const envelope: Envelope = {
    v: 1,
    kdf: "PBKDF2-HMAC-SHA256",
    kdf_params: { salt: "c2FsdA==", iterations: 200000 },
    nonce: "bm9uY2U=",
    ciphertext: "Y2lwaGVy",
    tag: "dGFn",
  };

  it("round-trips an envelope with its download timestamp", () => {
    const s = memStorage();
    writeCachedEnvelope(envelope, 1_700_000_000_000, {}, s);
    const got = readCachedEnvelope(s);
    expect(got?.at).toBe(1_700_000_000_000);
    expect(got?.envelope.ciphertext).toBe("Y2lwaGVy");
    expect(got?.envelope.kdf_params.iterations).toBe(200000);
  });

  it("round-trips HTTP validators and the meta version stamp", () => {
    const s = memStorage();
    writeCachedEnvelope(envelope, 1, { etag: 'W/"abc"', lastModified: "Wed, 21 Oct 2026 07:28:00 GMT", metaVersion: "v123" }, s);
    const got = readCachedEnvelope(s);
    expect(got?.etag).toBe('W/"abc"');
    expect(got?.lastModified).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(got?.metaVersion).toBe("v123");
  });

  it("defaults validators to null when none are supplied", () => {
    const s = memStorage();
    writeCachedEnvelope(envelope, 1, {}, s);
    const got = readCachedEnvelope(s);
    expect(got?.etag).toBeNull();
    expect(got?.lastModified).toBeNull();
    expect(got?.metaVersion).toBeNull();
  });

  it("returns null when nothing is cached or the store is corrupt", () => {
    const s = memStorage();
    expect(readCachedEnvelope(s)).toBeNull();
    s.setItem("iv.web.blob_cache", "{ not json");
    expect(readCachedEnvelope(s)).toBeNull();
    s.setItem("iv.web.blob_cache", JSON.stringify({ envelope }));
    expect(readCachedEnvelope(s)).toBeNull();
  });
});

describe("symbol plan cache", () => {
  it("round-trips a priority plan", () => {
    const s = memStorage();
    const plan = [
      { symbol: "BIG_ETF", priceType: "market", assetClass: "etf", sizeEur: 9000 },
      { symbol: "FUND", priceType: "nav", assetClass: "mutual_fund", sizeEur: 500 },
    ];
    writeSymbolPlan(plan, s);
    expect(readSymbolPlan(s)).toEqual(plan);
  });

  it("returns an empty array for missing/corrupt storage", () => {
    const s = memStorage();
    expect(readSymbolPlan(s)).toEqual([]);
    s.setItem("iv.web.symbol_plan", "{ not json");
    expect(readSymbolPlan(s)).toEqual([]);
    s.setItem("iv.web.symbol_plan", JSON.stringify({ not: "an array" }));
    expect(readSymbolPlan(s)).toEqual([]);
  });

  it("skips malformed entries and defaults missing fields", () => {
    const s = memStorage();
    s.setItem(
      "iv.web.symbol_plan",
      JSON.stringify([
        { symbol: "OK" },
        { symbol: "" },
        { notASymbol: true },
        { symbol: "TYPED", priceType: "nav", assetClass: "mutual_fund", sizeEur: 12 },
      ]),
    );
    expect(readSymbolPlan(s)).toEqual([
      { symbol: "OK", priceType: "market", assetClass: "", sizeEur: 0 },
      { symbol: "TYPED", priceType: "nav", assetClass: "mutual_fund", sizeEur: 12 },
    ]);
  });
});

describe("live EUR/USD cache", () => {
  it("round-trips the live spot and prior close", () => {
    const s = memStorage();
    writeCachedEurUsd({ now: new Decimal("1.085"), previousClose: new Decimal("1.0725") }, 5000, s);
    const got = readCachedEurUsd(s)!;
    expect(got.now?.toString()).toBe("1.085");
    expect(got.previousClose?.toString()).toBe("1.0725");
    expect(got.at).toBe(5000);
  });

  it("never clobbers a good reading with a null spot", () => {
    const s = memStorage();
    writeCachedEurUsd({ now: new Decimal("1.085"), previousClose: new Decimal("1.0725") }, 5000, s);
    writeCachedEurUsd({ now: null, previousClose: null }, 6000, s);
    const got = readCachedEurUsd(s)!;
    expect(got.now?.toString()).toBe("1.085");
    expect(got.at).toBe(5000);
  });

  it("returns null when nothing is cached", () => {
    expect(readCachedEurUsd(memStorage())).toBeNull();
  });
});

describe("clearPriceCaches", () => {
  it("wipes quotes, FX, EUR/USD and learned publish windows but keeps the credit log", () => {
    const s = memStorage();
    writeCachedQuotes(new Map([["VTI", quote("VTI", "100")]]), 1000, s);
    writeCachedFx({ base: "EUR", rates: { USD: new Decimal("1.1") } }, 1000, s);
    writeCachedEurUsd({ now: new Decimal("1.085"), previousClose: new Decimal("1.07") }, 1000, s);
    recordCredits(3, 1000, s);
    recordNavPublish("VTSAX", "2024-01-10", new Date(2024, 0, 10, 22, 30).getTime(), s);

    clearPriceCaches(s);

    expect(readCachedQuotes(s).size).toBe(0);
    expect(readCachedFx(s)).toBeNull();
    expect(readCachedEurUsd(s)).toBeNull();
    // The daily budget log survives a from-scratch pull so it still respects the
    // free-tier allowance; the learned publish windows are reset so a fund stuck
    // on an old NAV re-learns its window cleanly.
    expect(creditsSpentWithin(readCreditLog(1000, 60_000, s), 1000, 60_000)).toBe(3);
    expect(readNavPublishStats(s).size).toBe(0);
  });

  it("is a safe no-op when storage is unavailable", () => {
    expect(() => clearPriceCaches(null)).not.toThrow();
  });
});
