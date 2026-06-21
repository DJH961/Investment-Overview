/**
 * Tests for the free-tier-aware quote/FX orchestration (cache + budget +
 * retry/backoff + deferral). All network and timing is injected.
 */
import { describe, expect, it, vi } from "vitest";

import {
  recordCredits,
  writeCachedFx,
  writeCachedQuotes,
  type StorageLike,
} from "../src/cache";
import { loadFxRates, loadQuotes } from "../src/quotes";
import { PriceError, type FetchLike, type Quote } from "../src/prices";
import Decimal from "decimal.js";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, headers: { get: () => null } } as unknown as Response;
}

/**
 * A Twelve Data quote body for the requested symbols, every one priced at 100.
 * Mirrors the real API: a single symbol returns the node at the top level,
 * multiple symbols return a `{SYM: node}` map.
 */
function quoteBodyFor(requested: string[]): Record<string, unknown> {
  const node = { close: "100", previous_close: "99", currency: "USD" };
  if (requested.length === 1) return { symbol: requested[0], ...node };
  const out: Record<string, unknown> = {};
  for (const s of requested) out[s] = { ...node };
  return out;
}

function quoteResponse(url: string): Response {
  const requested = new URL(url).searchParams.get("symbol")!.split(",");
  return jsonResponse(quoteBodyFor(requested));
}

const noSleep = async (): Promise<void> => {};
const clock = (t: number) => () => t;

describe("loadQuotes — caching", () => {
  it("serves fresh cache entries without any fetch", async () => {
    const storage = memStorage();
    const fresh = new Map<string, Quote>([
      ["VTI", { symbol: "VTI", price: new Decimal("123"), previousClose: null, currency: "USD" }],
    ]);
    writeCachedQuotes(fresh, 1000, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const { quotes, report } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(1000 + 60_000), // within a 15-min TTL
      sleep: noSleep,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(quotes.get("VTI")?.price?.toString()).toBe("123");
    expect(report.servedFresh).toEqual(["VTI"]);
    expect(report.fetched).toEqual([]);
  });

  it("refetches once the cache is stale", async () => {
    const storage = memStorage();
    writeCachedQuotes(
      new Map([["VTI", { symbol: "VTI", price: new Decimal("1"), previousClose: null, currency: "USD" }]]),
      0,
      storage,
    );
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { quotes, report } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(20 * 60_000), // older than the 15-min default TTL
      sleep: noSleep,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(quotes.get("VTI")?.price?.toString()).toBe("100");
    expect(report.fetched).toEqual(["VTI"]);
  });
});

describe("loadQuotes — free-tier budget", () => {
  it("defers symbols beyond the per-minute credit budget", async () => {
    const storage = memStorage();
    const symbols = Array.from({ length: 12 }, (_, i) => `S${i}`);
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { report } = await loadQuotes(symbols, "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
      creditsPerMinute: 8,
    });
    // Only 8 credits/min may be spent, so 8 fetched and 4 deferred.
    expect(report.fetched.length).toBe(8);
    expect(report.deferred.length).toBe(4);
    expect(report.minuteRemaining).toBe(0);
  });

  it("spends nothing when the minute budget is already exhausted", async () => {
    const storage = memStorage();
    recordCredits(8, 0, storage); // burn the minute budget just now
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { report } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(1000),
      sleep: noSleep,
      creditsPerMinute: 8,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.deferred).toEqual(["VTI"]);
  });
});

describe("loadQuotes — retry/backoff", () => {
  it("retries a 429 with backoff, then succeeds", async () => {
    const storage = memStorage();
    let calls = 0;
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, false, 429);
      return quoteResponse(url);
    });
    const sleep = vi.fn(noSleep);
    const { quotes, report } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep,
      backoffBaseMs: 10,
    });
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(quotes.get("VTI")?.price?.toString()).toBe("100");
    expect(report.error).toBeNull();
  });

  it("falls back after exhausting retries on a persistent 429", async () => {
    const storage = memStorage();
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({}, false, 429));
    const { report } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
      maxRetries: 2,
      backoffBaseMs: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(report.error).toBeInstanceOf(PriceError);
    expect(report.deferred).toEqual(["VTI"]);
  });

  it("surfaces a non-retryable error with an empty result for the caller to act on", async () => {
    const storage = memStorage();
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ code: 401, status: "error", message: "bad key" }),
    );
    const { quotes, report } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
    });
    expect(quotes.size).toBe(0);
    expect(report.error?.message).toMatch(/bad key/);
  });
});

describe("loadFxRates", () => {
  it("serves a fresh FX cache without fetching", async () => {
    const storage = memStorage();
    writeCachedFx({ base: "EUR", rates: { USD: new Decimal("1.2") } }, 0, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const { fx, cached } = await loadFxRates({ fetchImpl, storage, now: clock(60_000) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cached).toBe(true);
    expect(fx.rates.USD.toString()).toBe("1.2");
  });

  it("falls back to the cached snapshot when the service fails", async () => {
    const storage = memStorage();
    writeCachedFx({ base: "EUR", rates: { USD: new Decimal("1.3") } }, 0, storage);
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({}, false, 503));
    const { fx, cached, error } = await loadFxRates({
      fetchImpl,
      storage,
      now: clock(13 * 60 * 60 * 1000), // older than the 12h TTL → tries network
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached).toBe(true);
    expect(error).toBeInstanceOf(PriceError);
    expect(fx.rates.USD.toString()).toBe("1.3");
  });
});
