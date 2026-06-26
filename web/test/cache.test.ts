/**
 * Tests for the localStorage-backed cache + credit-log primitives.
 * Uses an in-memory Storage stub so nothing touches the real browser.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  creditsSpentWithin,
  creditsSpentToday,
  creditsSpentThisHour,
  startOfHour,
  startOfUtcDay,
  readCachedEnvelope,
  readCachedEurUsd,
  readCachedFx,
  readCachedQuotes,
  readCreditLog,
  releaseCredits,
  releaseTiingoCredits,
  recordTiingoCredits,
  readTiingoCreditLog,
  tiingoCreditsSpentToday,
  readSymbolPlan,
  recordCredits,
  primeQuotesFromBars,
  writeCachedEnvelope,
  writeCachedEurUsd,
  writeCachedFx,
  writeCachedQuotes,
  writeSymbolPlan,
  readSessionStatus,
  writeSessionStatus,
  clearPriceCaches,
  readSeriesBackoff,
  writeSeriesBackoff,
  clearSeriesBackoff,
  clearAllSeriesBackoff,
  type StorageLike,
} from "../src/cache";
import type { Envelope } from "../src/crypto";
import type { Quote } from "../src/prices";
import type { Bar } from "../src/timeseries";

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

describe("primeQuotesFromBars", () => {
  const bar = (t: number, value: string): Bar => ({ t, value: new Decimal(value) });

  it("primes an uncached symbol from its newest bar using the supplied currency", () => {
    const s = memStorage();
    primeQuotesFromBars(
      new Map([["VTI", [bar(1000, "99"), bar(2000, "101")]]]),
      new Map([["VTI", "USD"]]),
      5000,
      s,
    );
    const got = readCachedQuotes(s).get("VTI")!;
    expect(got.quote.price?.toString()).toBe("101"); // the latest bar
    expect(got.at).toBe(5000); // fetch-fresh
    expect(got.quote.priceTime).toBe(2000); // the bar's own strike instant
    expect(got.quote.currency).toBe("USD");
  });

  it("only extends freshness — never overwrites a newer genuine quote", () => {
    const s = memStorage();
    writeCachedQuotes(new Map([["VTI", { ...quote("VTI", "100"), priceTime: 3000 }]]), 3000, s);
    // A bar older than the cached priceTime must not clobber the fresher quote.
    primeQuotesFromBars(new Map([["VTI", [bar(2000, "200")]]]), new Map(), 9000, s);
    const got = readCachedQuotes(s).get("VTI")!;
    expect(got.quote.price?.toString()).toBe("100");
    expect(got.at).toBe(3000);
  });

  it("advances a stale cached quote when the bar is newer, preserving prior close/currency", () => {
    const s = memStorage();
    writeCachedQuotes(new Map([["VTI", { ...quote("VTI", "100", "95") }]]), 1000, s);
    primeQuotesFromBars(new Map([["VTI", [bar(4000, "108")]]]), new Map(), 9000, s);
    const got = readCachedQuotes(s).get("VTI")!;
    expect(got.quote.price?.toString()).toBe("108");
    expect(got.quote.priceTime).toBe(4000);
    expect(got.at).toBe(9000);
    // Bars carry no prior close / currency — the cached ones are preserved.
    expect(got.quote.previousClose?.toString()).toBe("95");
    expect(got.quote.currency).toBe("USD");
  });

  it("skips an uncached symbol with no known currency (cannot denominate)", () => {
    const s = memStorage();
    primeQuotesFromBars(new Map([["MYSTERY", [bar(2000, "10")]]]), new Map(), 5000, s);
    expect(readCachedQuotes(s).has("MYSTERY")).toBe(false);
  });

  it("ignores empty bar lists and a no-op write", () => {
    const s = memStorage();
    primeQuotesFromBars(new Map([["VTI", []]]), new Map([["VTI", "USD"]]), 5000, s);
    expect(readCachedQuotes(s).size).toBe(0);
  });

  it("C5: stamps a NAV bar tip as a settled, value-dated close (not live)", () => {
    const s = memStorage();
    // 2026-06-19 UTC midnight — the settled NAV bar day.
    const day = Date.parse("2026-06-19T00:00:00Z");
    primeQuotesFromBars(
      new Map([["FXAIX", [bar(day, "210.5")]]]),
      new Map([["FXAIX", "USD"]]),
      9_000_000,
      s,
      new Set(["FXAIX"]),
    );
    const got = readCachedQuotes(s).get("FXAIX")!;
    expect(got.quote.price?.toString()).toBe("210.5");
    // The value-date is the bar day so priceForHolding accepts it as the headline.
    expect(got.quote.valueDate).toBe("2026-06-19");
    // A NAV tip is settled, never a live tick.
    expect(got.quote.marketOpen).toBe(false);
  });

  it("C5: a non-NAV symbol keeps a null value-date (never mislabelled settled NAV)", () => {
    const s = memStorage();
    const day = Date.parse("2026-06-19T00:00:00Z");
    primeQuotesFromBars(new Map([["VTI", [bar(day, "300")]]]), new Map([["VTI", "USD"]]), 9_000_000, s);
    const got = readCachedQuotes(s).get("VTI")!;
    expect(got.quote.valueDate).toBeNull();
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

  it("releaseCredits refunds a reserved spend so the running total nets out", () => {
    const s = memStorage();
    // Reserve 3 up-front, then learn the call was never billed and refund it.
    recordCredits(3, 1000, s);
    releaseCredits(3, 1100, s);
    const log = readCreditLog(2000, 24 * 60 * 60 * 1000, s);
    expect(creditsSpentWithin(log, 2000, 60 * 1000)).toBe(0);
    // A partial refund leaves only the genuinely-billed remainder on the books.
    recordCredits(2, 1500, s);
    releaseCredits(1, 1600, s);
    expect(creditsSpentWithin(readCreditLog(2000, 24 * 60 * 60 * 1000, s), 2000, 60 * 1000)).toBe(1);
  });

  it("releaseCredits ignores non-positive refunds", () => {
    const s = memStorage();
    recordCredits(2, 1000, s);
    releaseCredits(0, 1100, s);
    releaseCredits(-5, 1100, s);
    expect(creditsSpentWithin(readCreditLog(2000, 60_000, s), 2000, 60_000)).toBe(2);
  });

  it("releaseTiingoCredits refunds against the separate Tiingo ledger", () => {
    const s = memStorage();
    recordTiingoCredits(1, 1000, s);
    releaseTiingoCredits(1, 1100, s);
    const log = readTiingoCreditLog(2000, 24 * 60 * 60 * 1000, s);
    expect(tiingoCreditsSpentToday(log, 1100)).toBe(0);
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

  it("counts the hourly budget from the top of the clock hour, not a rolling 60min window", () => {
    const s = memStorage();
    const HOUR = 60 * 60 * 1000;
    // A spend late in hour 9 (09:55) and one early in hour 10 (10:05).
    const nineFiftyFive = 9 * HOUR + 55 * 60 * 1000;
    const tenOhFive = 10 * HOUR + 5 * 60 * 1000;
    recordCredits(30, nineFiftyFive, s);
    recordCredits(4, tenOhFive, s);
    const log = readCreditLog(tenOhFive, 24 * HOUR, s);
    // startOfHour lands exactly on the clock hour boundary.
    expect(startOfHour(tenOhFive)).toBe(10 * HOUR);
    // A rolling 60-min window would wrongly include the 30 from 09:55...
    expect(creditsSpentWithin(log, tenOhFive, HOUR)).toBe(34);
    // ...but the top-of-hour reset means only the 4 from 10:05 count.
    expect(creditsSpentThisHour(log, tenOhFive)).toBe(4);
  });

  it("startOfUtcDay lands exactly on the most recent UTC midnight", () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(startOfUtcDay(5 * DAY)).toBe(5 * DAY); // already midnight
    expect(startOfUtcDay(5 * DAY + 1)).toBe(5 * DAY); // 1ms past midnight
    expect(startOfUtcDay(6 * DAY - 1)).toBe(5 * DAY); // 1ms before next midnight
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
      { symbol: "BIG_ETF", priceType: "market", assetClass: "etf", sizeEur: 9000, nativeCurrency: "USD" },
      { symbol: "FUND", priceType: "nav", assetClass: "mutual_fund", sizeEur: 500, nativeCurrency: "EUR" },
    ];
    writeSymbolPlan(plan, s);
    expect(readSymbolPlan(s)).toEqual(plan);
  });

  it("defaults a legacy plan with no nativeCurrency to null (C2 back-compat)", () => {
    const s = memStorage();
    s.setItem(
      "iv.web.symbol_plan",
      JSON.stringify([{ symbol: "OLD", priceType: "market", assetClass: "etf", sizeEur: 7 }]),
    );
    expect(readSymbolPlan(s)).toEqual([
      { symbol: "OLD", priceType: "market", assetClass: "etf", sizeEur: 7, nativeCurrency: null },
    ]);
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
      { symbol: "OK", priceType: "market", assetClass: "", sizeEur: 0, nativeCurrency: null },
      { symbol: "TYPED", priceType: "nav", assetClass: "mutual_fund", sizeEur: 12, nativeCurrency: null },
    ]);
  });
});

describe("session status snapshot", () => {
  const sample = {
    at: 1_700_000_000_000,
    lastPullAt: 1_699_999_000_000,
    marketPhase: "closed",
    marketCovered: true,
    navCovered: false,
    sessionGraphDay: "2026-06-23",
    weekGraphCovered: false,
  };

  it("round-trips a snapshot", () => {
    const s = memStorage();
    writeSessionStatus(sample, s);
    expect(readSessionStatus(s)).toEqual(sample);
  });

  it("returns null for missing/corrupt storage", () => {
    const s = memStorage();
    expect(readSessionStatus(s)).toBeNull();
    s.setItem("iv.web.session_status", "{ not json");
    expect(readSessionStatus(s)).toBeNull();
    s.setItem("iv.web.session_status", JSON.stringify({ no: "at field" }));
    expect(readSessionStatus(s)).toBeNull();
  });

  it("defaults missing/odd fields safely", () => {
    const s = memStorage();
    s.setItem("iv.web.session_status", JSON.stringify({ at: 42 }));
    expect(readSessionStatus(s)).toEqual({
      at: 42,
      lastPullAt: null,
      marketPhase: "settled",
      marketCovered: false,
      navCovered: false,
      sessionGraphDay: null,
      weekGraphCovered: false,
    });
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
  it("wipes quotes, FX and EUR/USD but keeps the credit log", () => {
    const s = memStorage();
    writeCachedQuotes(new Map([["VTI", quote("VTI", "100")]]), 1000, s);
    writeCachedFx({ base: "EUR", rates: { USD: new Decimal("1.1") } }, 1000, s);
    writeCachedEurUsd({ now: new Decimal("1.085"), previousClose: new Decimal("1.07") }, 1000, s);
    recordCredits(3, 1000, s);

    clearPriceCaches(s);

    expect(readCachedQuotes(s).size).toBe(0);
    expect(readCachedFx(s)).toBeNull();
    expect(readCachedEurUsd(s)).toBeNull();
    // The daily budget log survives a from-scratch pull so it still respects the
    // free-tier allowance.
    expect(creditsSpentWithin(readCreditLog(1000, 60_000, s), 1000, 60_000)).toBe(3);
  });

  it("is a safe no-op when storage is unavailable", () => {
    expect(() => clearPriceCaches(null)).not.toThrow();
  });
});

describe("time-series backoff store", () => {
  it("round-trips and clears a single series' backoff entry", () => {
    const s = memStorage();
    expect(readSeriesBackoff("1W:AAPL", s)).toBeNull();
    writeSeriesBackoff("1W:AAPL", { fails: 2, armedAt: null }, s);
    expect(readSeriesBackoff("1W:AAPL", s)).toEqual({ fails: 2, armedAt: null });
    writeSeriesBackoff("1W:AAPL", { fails: 3, armedAt: 5000 }, s);
    expect(readSeriesBackoff("1W:AAPL", s)).toEqual({ fails: 3, armedAt: 5000 });
    clearSeriesBackoff("1W:AAPL", s);
    expect(readSeriesBackoff("1W:AAPL", s)).toBeNull();
  });

  it("keeps distinct keys independent (1D vs 1W, price vs fx)", () => {
    const s = memStorage();
    writeSeriesBackoff("1D:AAPL", { fails: 3, armedAt: 1000 }, s);
    writeSeriesBackoff("1W:AAPL", { fails: 1, armedAt: null }, s);
    writeSeriesBackoff("fx:1W:1day", { fails: 3, armedAt: 1000 }, s);
    clearSeriesBackoff("1D:AAPL", s);
    expect(readSeriesBackoff("1D:AAPL", s)).toBeNull();
    expect(readSeriesBackoff("1W:AAPL", s)).toEqual({ fails: 1, armedAt: null });
    expect(readSeriesBackoff("fx:1W:1day", s)).toEqual({ fails: 3, armedAt: 1000 });
  });

  it("clearAllSeriesBackoff wipes every entry (Settings hard refresh)", () => {
    const s = memStorage();
    writeSeriesBackoff("1D:AAPL", { fails: 3, armedAt: 1000 }, s);
    writeSeriesBackoff("fx:1D:1hour", { fails: 3, armedAt: 1000 }, s);
    clearAllSeriesBackoff(s);
    expect(readSeriesBackoff("1D:AAPL", s)).toBeNull();
    expect(readSeriesBackoff("fx:1D:1hour", s)).toBeNull();
  });

  it("tolerates malformed persisted entries", () => {
    const s = memStorage();
    s.setItem("iv.web.series_backoff", JSON.stringify({ "1W:AAPL": { fails: "x", armedAt: "y" } }));
    expect(readSeriesBackoff("1W:AAPL", s)).toEqual({ fails: 0, armedAt: null });
    expect(() => clearAllSeriesBackoff(null)).not.toThrow();
  });
});
