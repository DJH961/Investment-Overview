/**
 * Tests for the free-tier-aware quote/FX orchestration (cache + budget +
 * retry/backoff + deferral). All network and timing is injected.
 */
import { describe, expect, it, vi } from "vitest";

import {
  recordCredits,
  writeCachedEurUsd,
  writeCachedFx,
  writeCachedQuotes,
  type StorageLike,
} from "../src/cache";
import { loadEurUsd, loadFxRates, loadQuotes, navCacheTtlMs, navPublishWindow, DEFAULT_NAV_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS } from "../src/quotes";
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
  const node = { close: "100", previous_close: "99", currency: "USD", datetime: "2024-01-10" };
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

  it("stamps the observation time on fetched and cached quotes", async () => {
    const storage = memStorage();
    writeCachedQuotes(
      new Map([["OLD", { symbol: "OLD", price: new Decimal("5"), previousClose: null, currency: "USD" }]]),
      1234,
      storage,
    );
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const fetchAt = 10 * 60_000; // OLD still fresh (15-min TTL), NEW fetched now
    const { quotes } = await loadQuotes(["OLD", "NEW"], "key", {
      fetchImpl,
      storage,
      now: clock(fetchAt),
      sleep: noSleep,
    });
    expect(quotes.get("OLD")?.at).toBe(1234); // carried from the cache entry
    expect(quotes.get("NEW")?.at).toBe(fetchAt); // stamped at fetch time
  });

  it("fetches NAV symbols from time_series and market symbols from quote", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      calls.push(url);
      if (url.includes("/time_series")) {
        const requested = new URL(url).searchParams.get("symbol")!.split(",");
        const node = (): Record<string, unknown> => ({
          meta: { currency: "USD" },
          values: [{ datetime: "2024-06-20", close: "200" }],
          status: "ok",
        });
        if (requested.length === 1) return jsonResponse(node());
        const out: Record<string, unknown> = {};
        for (const s of requested) out[s] = node();
        return jsonResponse(out);
      }
      return quoteResponse(url);
    });
    const { quotes } = await loadQuotes(["VTI", "FXAIX"], "key", {
      fetchImpl,
      storage: memStorage(),
      now: clock(0),
      sleep: noSleep,
      navSymbols: new Set(["FXAIX"]),
    });
    // Two endpoints were hit: quote (market) and time_series (NAV).
    expect(calls.some((u) => u.includes("/quote"))).toBe(true);
    expect(calls.some((u) => u.includes("/time_series"))).toBe(true);
    expect(quotes.get("VTI")?.price?.toString()).toBe("100");
    expect(quotes.get("FXAIX")?.price?.toString()).toBe("200");
    expect(quotes.get("FXAIX")?.valueDate).toBe("2024-06-20");
  });

  it("keeps NAV symbols fresh under a longer per-symbol TTL", async () => {
    const storage = memStorage();
    // Both cached at t=0; market's 15-min TTL is blown by t=1h, NAV's 12h isn't.
    writeCachedQuotes(
      new Map([
        ["VTI", { symbol: "VTI", price: new Decimal("1"), previousClose: null, currency: "USD" }],
        ["FXAIX", { symbol: "FXAIX", price: new Decimal("2"), previousClose: null, currency: "USD" }],
      ]),
      0,
      storage,
    );
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { report } = await loadQuotes(["VTI", "FXAIX"], "key", {
      fetchImpl,
      storage,
      now: clock(60 * 60_000), // 1 hour later
      sleep: noSleep,
      cacheTtlMsForSymbol: (s) => (s === "FXAIX" ? 12 * 60 * 60_000 : 15 * 60_000),
    });
    expect(report.servedFresh).toEqual(["FXAIX"]);
    expect(report.fetched).toEqual(["VTI"]);
  });

  it("forceMarketFetch re-fetches fresh market quotes but spares NAV symbols", async () => {
    const storage = memStorage();
    // Both cached and well within their TTLs.
    writeCachedQuotes(
      new Map([
        ["VTI", { symbol: "VTI", price: new Decimal("1"), previousClose: null, currency: "USD" }],
        ["FXAIX", { symbol: "FXAIX", price: new Decimal("2"), previousClose: null, currency: "USD" }],
      ]),
      0,
      storage,
    );
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { report } = await loadQuotes(["VTI", "FXAIX"], "key", {
      fetchImpl,
      storage,
      now: clock(60_000), // 1 min later — both still cache-fresh
      sleep: noSleep,
      navSymbols: new Set(["FXAIX"]),
      cacheTtlMsForSymbol: (s) => (s === "FXAIX" ? 12 * 60 * 60_000 : 15 * 60_000),
      forceMarketFetch: true,
    });
    // The market symbol is force-refetched; the once-a-day NAV is left on cache.
    expect(report.fetched).toEqual(["VTI"]);
    expect(report.servedFresh).toEqual(["FXAIX"]);
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

  it("reserves credits before the fetch resolves, so an overlapping load can't double-spend", async () => {
    const storage = memStorage();
    // A slow fetch that doesn't resolve until we let it, modelling a prefetch
    // still in flight while a second refresh starts.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const slow = vi.fn<FetchLike>(async (url) => {
      await gate;
      return quoteResponse(url);
    });
    const first = loadQuotes(
      Array.from({ length: 8 }, (_, i) => `A${i}`),
      "key",
      { fetchImpl: slow, storage, now: clock(0), sleep: noSleep, creditsPerMinute: 8 },
    );
    // The first load has synchronously reserved its 8 credits before awaiting
    // the network, so a second load starting now sees a spent minute budget and
    // defers entirely instead of firing another full batch (→ HTTP 429).
    const second = await loadQuotes(["B0"], "key", {
      fetchImpl: vi.fn<FetchLike>(async (url) => quoteResponse(url)),
      storage,
      now: clock(0),
      sleep: noSleep,
      creditsPerMinute: 8,
    });
    expect(second.report.deferred).toEqual(["B0"]);
    expect(second.report.fetched).toEqual([]);
    resolveGate();
    await first;
  });

  it("keeps last-known values (not a dead-end) on a non-fatal HTTP error like 404", async () => {
    const storage = memStorage();
    // A cached value exists from an earlier successful pull.
    writeCachedQuotes(
      new Map<string, Quote>([
        ["VTI", { symbol: "VTI", price: new Decimal("123"), previousClose: null, currency: "USD" }],
      ]),
      0,
      storage,
    );
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({}, false, 404));
    const { quotes, report } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(20 * 60 * 1000), // past the cache TTL, so a refetch is attempted
      sleep: noSleep,
    });
    // Non-fatal: the error is reported but the cached value is still returned,
    // and the caller is *not* handed an empty result to dead-end on.
    expect(report.error).toBeInstanceOf(PriceError);
    expect(report.error?.fatal).toBe(false);
    expect(quotes.get("VTI")?.price?.toString()).toBe("123");
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

describe("navCacheTtlMs — adaptive NAV refresh", () => {
  // Local-time constructors keep these assertions timezone-independent, matching
  // the helper's use of local getters. 2024-01-10 is a Wednesday. The default
  // publish hour is now 22:00 (European market close), so evening checks use 22+.
  const wed = (h: number, m = 0) => new Date(2024, 0, 10, h, m).getTime();
  const sat = (h: number) => new Date(2024, 0, 13, h).getTime();

  it("relaxes to the long window once today's NAV is in hand", () => {
    const ttl = navCacheTtlMs({ valueDate: "2024-01-10" }, { now: wed(22, 30) });
    expect(ttl).toBe(DEFAULT_NAV_CACHE_TTL_MS);
  });

  it("polls hard during the evening window while the new NAV is still missing", () => {
    const ttl = navCacheTtlMs({ valueDate: "2024-01-09" }, { now: wed(22, 30) });
    expect(ttl).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("chases an unknown (uncached) value-date during the window", () => {
    expect(navCacheTtlMs(null, { now: wed(22, 30) })).toBe(DEFAULT_CACHE_TTL_MS);
    expect(navCacheTtlMs({ valueDate: null }, { now: wed(22, 30) })).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("stays on the long window outside the publish window even if behind", () => {
    // 12:00 is before the 22:00 publish hour; expected = previous business day.
    const ttl = navCacheTtlMs({ valueDate: "2024-01-08" }, { now: wed(12) });
    expect(ttl).toBe(DEFAULT_NAV_CACHE_TTL_MS);
  });

  it("never polls on a weekend (no NAV publishes)", () => {
    // Saturday evening: latest expected is Friday's NAV, which we already hold.
    expect(navCacheTtlMs({ valueDate: "2024-01-12" }, { now: sat(22) })).toBe(DEFAULT_NAV_CACHE_TTL_MS);
    // Even missing, a weekend evening is never a publish window.
    expect(navCacheTtlMs({ valueDate: "2024-01-05" }, { now: sat(22) })).toBe(DEFAULT_NAV_CACHE_TTL_MS);
  });

  it("backs off again past the catch-up window", () => {
    // publishHour 22 + 1h window ends at 23:00; 22:30 is inside, 23:30 is past it.
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, { now: wed(23, 30), catchUpWindowHours: 1 })).toBe(
      DEFAULT_NAV_CACHE_TTL_MS,
    );
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, { now: wed(22, 30), catchUpWindowHours: 1 })).toBe(
      DEFAULT_CACHE_TTL_MS,
    );
  });

  it("honours an explicit (learned) publish hour", () => {
    // A fund taught to publish at 18:00: 18:30 polls hard, 21:00 is past its 1h window.
    const opts = { publishHour: 18, catchUpWindowHours: 1 };
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, { ...opts, now: wed(18, 30) })).toBe(DEFAULT_CACHE_TTL_MS);
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, { ...opts, now: wed(21) })).toBe(DEFAULT_NAV_CACHE_TTL_MS);
  });

  it("honours custom short/long TTL overrides", () => {
    const opts = { now: wed(22, 30), shortTtlMs: 1234, longTtlMs: 5678 };
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, opts)).toBe(1234);
    expect(navCacheTtlMs({ valueDate: "2024-01-10" }, opts)).toBe(5678);
  });

  it("carries the fetched quote's value-date through to the cache", async () => {
    const storage = memStorage();
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { quotes } = await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
    });
    expect(quotes.get("VTI")?.valueDate).toBe("2024-01-10");
  });
});

describe("navPublishWindow — learning the window from observed data", () => {
  it("falls back to the bootstrap default with no observations", () => {
    expect(navPublishWindow()).toEqual({ publishHour: 22, catchUpWindowHours: 2 });
    expect(navPublishWindow([])).toEqual({ publishHour: 22, catchUpWindowHours: 2 });
  });

  it("brackets a tight observed band into a tight window", () => {
    // Always seen at ~22:00 → opens 22:00, closes one hour past (lag) → 1h window.
    expect(navPublishWindow([22, 22, 22])).toEqual({ publishHour: 22, catchUpWindowHours: 1 });
  });

  it("widens to span the observed spread plus trailing slack", () => {
    // Seen between 21:54 and 22:18 → opens 21:00, ceil(22.3)+1 lag → closes 24:00.
    expect(navPublishWindow([21.9, 22.3, 22.1])).toEqual({ publishHour: 21, catchUpWindowHours: 3 });
  });

  it("ignores out-of-range / non-finite samples", () => {
    expect(navPublishWindow([Number.NaN, -3, 25, 22])).toEqual({ publishHour: 22, catchUpWindowHours: 1 });
  });

  it("reports an advancing value-date so callers can learn the publish time", async () => {
    const storage = memStorage();
    const seen: Array<[string, string, number]> = [];
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    await loadQuotes(["VTI"], "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
      onValueDateAdvance: (symbol, valueDate, at) => seen.push([symbol, valueDate, at]),
    });
    expect(seen).toEqual([["VTI", "2024-01-10", 0]]);
  });
});

describe("loadEurUsd", () => {
  it("serves a fresh cached reading without spending a credit", async () => {
    const storage = memStorage();
    writeCachedEurUsd({ now: new Decimal("1.085"), previousClose: new Decimal("1.0725") }, 0, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const res = await loadEurUsd("key", { fetchImpl, storage, now: clock(1000), ttlMs: 60_000 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.source).toBe("cache");
    expect(res.now?.toString()).toBe("1.085");
    expect(res.previousClose?.toString()).toBe("1.0725");
  });

  it("fetches a live pair (spot + prior close) and caches it", async () => {
    const storage = memStorage();
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ symbol: "EUR/USD", close: "1.0900", previous_close: "1.0750", currency: "USD" }),
    );
    const res = await loadEurUsd("key", { fetchImpl, storage, now: clock(0) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.source).toBe("live");
    expect(res.now?.toString()).toBe("1.09");
    expect(res.previousClose?.toString()).toBe("1.075");
    // Cached for the next call.
    const again = await loadEurUsd("key", { fetchImpl, storage, now: clock(1000), ttlMs: 60_000 });
    expect(again.source).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the end-of-day ECB rate (no prior close) when over budget", async () => {
    const storage = memStorage();
    // Exhaust the per-minute budget.
    recordCredits(8, 0, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const res = await loadEurUsd("key", {
      fetchImpl,
      storage,
      now: clock(1000),
      eodFallback: new Decimal("1.07"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.source).toBe("eod");
    expect(res.now?.toString()).toBe("1.07");
    expect(res.previousClose).toBeNull();
  });

  it("reports source none when nothing is available", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ symbol: "EUR/USD", status: "error", message: "no data" }),
    );
    const res = await loadEurUsd("key", { fetchImpl, storage: memStorage(), now: clock(0) });
    expect(res.source).toBe("none");
    expect(res.now).toBeNull();
  });
});
