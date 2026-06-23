/**
 * Orchestration tests for `runTiingoFallback`: the wiring that runs after the
 * Twelve Data pass and decides whether to spend Tiingo calls on the gaps. These
 * exercise the I/O paths (budget reservation, quote merge, NAV peer evidence)
 * against an in-memory storage + a stubbed `/price` fetch; the pure decision
 * logic itself is covered by `tiingo-gate.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { Decimal } from "../src/decimal-config";
import { PriceError, type Quote } from "../src/prices";
import { latestSettledSessionDate } from "../src/market-hours";
import { runTiingoFallback } from "../src/tiingo-fallback";
import { tiingoCreditsSpentToday, readTiingoCreditLog, type StorageLike } from "../src/cache";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const PROXY = "https://worker.example.dev/price";
const NOW = Date.UTC(2026, 5, 23, 18, 0, 0); // weekday afternoon ET
const EXPECTED = latestSettledSessionDate(new Date(NOW));

function emptyReport(deferred: string[] = []) {
  return { fetched: [], servedFresh: [], deferred, error: null, minuteRemaining: 0, dayRemaining: 0 };
}

/** A stub `/price` fetch returning the given IEX rows as JSON. */
function stubFetch(rows: Record<string, unknown>[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => rows,
  })) as unknown as typeof fetch;
}

function iexRow(ticker: string, last: number, timestamp: string): Record<string, unknown> {
  return { ticker, tngoLast: last, prevClose: last - 1, timestamp };
}

describe("runTiingoFallback", () => {
  it("is a no-op when no proxy URL is configured", async () => {
    const fetchImpl = vi.fn();
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: null,
      now: NOW,
      storage: memStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.budget).toEqual({ hourUsed: 0, hourLimit: 40, dayUsed: 0, dayLimit: 800 });
  });

  it("fills a deferred market symbol from Tiingo and reserves the budget", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([iexRow("AAPL", 200, `${EXPECTED}T20:00:00Z`)]);
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    expect(out.tiingoSymbols).toEqual(["AAPL"]);
    expect(out.quotes.get("AAPL")?.price?.toString()).toBe("200");
    expect(out.error).toBeNull();
    // Budget reserved up-front: one ticker spent today.
    expect(tiingoCreditsSpentToday(readTiingoCreditLog(NOW, undefined, storage), NOW)).toBe(1);
    expect(out.budget.dayUsed).toBe(1);
  });

  it("does not overwrite a fresher primary value with an older Tiingo bar", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([iexRow("AAPL", 150, "2020-01-02T20:00:00Z")]);
    const fresh: Quote = {
      symbol: "AAPL",
      price: new Decimal(199),
      previousClose: null,
      currency: "USD",
      at: NOW,
      priceTime: NOW,
      valueDate: EXPECTED,
      marketOpen: null,
    };
    const quotes = new Map<string, Quote>([["AAPL", fresh]]);
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(out.quotes.get("AAPL")?.price?.toString()).toBe("199");
  });

  it("fetches NAV laggards when a peer fund already published the target date", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([iexRow("FSKAX", 100, `${EXPECTED}T21:00:00Z`)]);
    const peer: Quote = {
      symbol: "VTSAX",
      price: new Decimal(120),
      previousClose: null,
      currency: "USD",
      at: NOW - 31 * 60_000,
      priceTime: null,
      valueDate: EXPECTED,
      marketOpen: null,
    };
    const quotes = new Map<string, Quote>([["VTSAX", peer]]);
    const out = await runTiingoFallback({
      symbols: ["VTSAX", "FSKAX"],
      navSymbols: new Set(["VTSAX", "FSKAX"]),
      quotes,
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    expect(out.tiingoSymbols).toEqual(["FSKAX"]);
    expect(out.quotes.get("FSKAX")?.valueDate).toBe(EXPECTED);
    // NAV fund: no faux intraday strike time.
    expect(out.quotes.get("FSKAX")?.priceTime).toBeNull();
  });

  it("never throws on a transient fetch failure; reports it on .error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage: memStorage(),
      fetchImpl,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(out.error).toBeInstanceOf(PriceError);
    expect(out.error?.retryable).toBe(true);
  });
});
