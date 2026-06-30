/**
 * Tests for the free-tier-aware quote/FX orchestration (cache + budget +
 * retry/backoff + deferral). All network and timing is injected.
 */
import { describe, expect, it, vi } from "vitest";

import {
  recordCredits,
  recordTiingoCredits,
  releaseCredits,
  readCreditLog,
  readTiingoCreditLog,
  tiingoCreditsSpentToday,
  creditsSpentWithin,
  writeCachedEurUsd,
  writeCachedFx,
  writeCachedQuotes,
  type StorageLike,
} from "../src/cache";
import {
  loadEurUsd,
  loadFxRates,
  loadQuotes,
  marketCacheTtlMs,
  holdsSettledClose,
  navCacheTtlMs,
  twelveDataBudgetRemaining,
  DEFAULT_CLOSED_MARKET_TTL_MS,
  DEFAULT_NAV_CACHE_TTL_MS,
  DEFAULT_CACHE_TTL_MS,
} from "../src/quotes";
import { PriceError, type FetchLike, type Quote } from "../src/prices";
import { nextSessionCloseMs } from "../src/market-hours";
import { WEB_DAILY_CAP } from "../src/tiingo-gate";
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

/**
 * A Twelve Data `time_series` (daily NAV) body for the requested symbols. Mirrors
 * the real API: `{meta, values:[…]}` at the top level for a single symbol, a
 * `{SYM: {meta, values}}` map for several. Every bar closes at 100.
 */
function navBodyFor(requested: string[]): Record<string, unknown> {
  const node = {
    meta: { symbol: requested[0], currency: "USD" },
    values: [
      { datetime: "2024-01-10", close: "100" },
      { datetime: "2024-01-09", close: "99" },
    ],
  };
  if (requested.length === 1) return node;
  const out: Record<string, unknown> = {};
  for (const s of requested) {
    out[s] = { meta: { symbol: s, currency: "USD" }, values: node.values };
  }
  return out;
}

function quoteResponse(url: string): Response {
  const parsed = new URL(url);
  const requested = parsed.searchParams.get("symbol")!.split(",");
  // Route NAV (mutual-fund) pulls to the daily time_series shape, market pulls to
  // the quote shape — exactly as loadQuotes splits its batches in production.
  const body = parsed.pathname.endsWith("/time_series")
    ? navBodyFor(requested)
    : quoteBodyFor(requested);
  return jsonResponse(body);
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

  it("forceFetch opts a specific (behind) NAV symbol back into a forced refresh", async () => {
    const storage = memStorage();
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
      // forceMarketFetch re-pulls the market symbol (VTI); forceFetch additionally
      // opts the behind NAV (FXAIX) back in, so both are fetched this call.
      forceFetch: (s) => s === "FXAIX",
    });
    expect(report.fetched.sort()).toEqual(["FXAIX", "VTI"]);
    expect(report.servedFresh).toEqual([]);
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

  it("fetches forced symbols first when the per-minute budget can't cover them all", async () => {
    // 12 stale symbols, only 8 credits/min. The last two (S10, S11) are opted in
    // by forceFetch — a deferred-queue drain / manual force. They sit at the back
    // of the incoming order, yet must jump the budget queue and be fetched, while
    // two *ordinary* stale symbols defer instead.
    const storage = memStorage();
    const symbols = Array.from({ length: 12 }, (_, i) => `S${i}`);
    const forced = new Set(["S10", "S11"]);
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { report } = await loadQuotes(symbols, "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
      creditsPerMinute: 8,
      forceFetch: (s) => forced.has(s),
    });
    expect(report.fetched.length).toBe(8);
    // Both forced symbols were fetched despite trailing the incoming order…
    expect(report.fetched).toContain("S10");
    expect(report.fetched).toContain("S11");
    // …and the deferred remainder is purely ordinary stale symbols.
    expect(report.deferred).not.toContain("S10");
    expect(report.deferred).not.toContain("S11");
    expect(report.deferred.length).toBe(4);
  });

  it("onPlan reports the deferred-from-last (forced) symbols in `fetching`, never bumped to a later round", async () => {
    // Regression for the auto-update animation bug: a round must pull the symbols
    // deferred from last time *first* and only push genuinely-ordinary overflow to
    // a later round — it must never do "its own" symbols and re-defer the forced
    // ones while there was budget for them. `onPlan` is the single source of truth
    // the row animation paints from, so we assert it splits forced-first.
    const storage = memStorage();
    const symbols = Array.from({ length: 12 }, (_, i) => `S${i}`);
    // S8..S11 are drained from the deferred queue this round (forced). They trail
    // the incoming order, yet there is budget (8/min) for all four plus four
    // ordinary symbols — so all four forced symbols belong in `fetching`.
    const forced = new Set(["S8", "S9", "S10", "S11"]);
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    let plan: { fetching: string[]; deferred: string[] } | null = null;
    await loadQuotes(symbols, "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
      creditsPerMinute: 8,
      forceFetch: (s) => forced.has(s),
      onPlan: (p) => {
        plan = p;
      },
    });
    expect(plan).not.toBeNull();
    const resolved = plan as unknown as { fetching: string[]; deferred: string[] };
    // Every deferred-from-last (forced) symbol is fetched this round…
    for (const s of forced) expect(resolved.fetching).toContain(s);
    // …and the overflow pushed to a later round is purely ordinary stale symbols.
    for (const s of forced) expect(resolved.deferred).not.toContain(s);
    expect(resolved.fetching.length).toBe(8);
    expect(resolved.deferred.length).toBe(4);
  });

  it("reports an attempted-but-unpriced symbol as failed, not deferred", async () => {
    // The provider returns a node for VTI but a null/empty one for FAIL (the
    // FSKAX case): both were attempted, VTI prices, FAIL doesn't. FAIL must be
    // reported as failed (genuinely stuck) rather than deferred (waiting its turn).
    const storage = memStorage();
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({
        VTI: { close: "100", previous_close: "99", currency: "USD", datetime: "2024-01-10" },
        FAIL: { close: null, currency: "USD" },
      }),
    );
    const { quotes, report } = await loadQuotes(["VTI", "FAIL"], "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
      creditsPerMinute: 8,
    });
    expect(report.fetched).toEqual(["VTI"]);
    expect(report.failed).toEqual(["FAIL"]);
    expect(report.deferred).toEqual([]);
    expect(quotes.get("VTI")?.price?.toString()).toBe("100");
  });

  it("keeps a budget-deferred symbol in deferred, never failed", async () => {
    const storage = memStorage();
    const symbols = Array.from({ length: 10 }, (_, i) => `S${i}`);
    const fetchImpl = vi.fn<FetchLike>(async (url) => quoteResponse(url));
    const { report } = await loadQuotes(symbols, "key", {
      fetchImpl,
      storage,
      now: clock(0),
      sleep: noSleep,
      creditsPerMinute: 8,
    });
    // 8 fetched, 2 never attempted → deferred (not failed): they just await budget.
    expect(report.fetched.length).toBe(8);
    expect(report.deferred.length).toBe(2);
    expect(report.failed).toEqual([]);
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
    // VTI was *attempted* (and couldn't be priced after the retries), so it is
    // reported as failed rather than merely deferred for budget.
    expect(report.failed).toEqual(["VTI"]);
    expect(report.deferred).toEqual([]);
    // The call delivered nothing, so its reserved credit is refunded — the
    // accounting stays truthful (never "spent" a credit the provider didn't take),
    // and the full minute budget is available again for the next round.
    expect(report.apiCalls).toBe(1);
    expect(report.creditsSpent).toBe(0);
    expect(twelveDataBudgetRemaining(0, { storage }).minute).toBe(8);
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
  // Local-time constructors keep these assertions timezone-independent on the
  // UTC CI runner (local == UTC), matching the helper's ET-anchored session
  // math. 2024-01-10 is a Wednesday. There is no publish-time prediction any
  // more: poll after the close until the settled session's NAV is in hand.
  const wed = (h: number, m = 0) => new Date(2024, 0, 10, h, m).getTime();
  const sat = (h: number) => new Date(2024, 0, 13, h).getTime();

  it("relaxes to the market-day rest window once the settled session's NAV is in hand", () => {
    // 17:30 ET Wed — market closed, Wednesday has settled and we hold it. With no
    // cached observation time the rest window is anchored at `now` and reaches the
    // next session close (market-day based), not a flat 24h.
    const now = wed(22, 30);
    const ttl = navCacheTtlMs({ valueDate: "2024-01-10" }, { now });
    expect(ttl).toBe(nextSessionCloseMs(new Date(now)) - now);
  });

  it("rests during the post-close NAV-pending window while only the prior session's NAV is in hand", () => {
    // 17:30 ET Wed — closed, Wednesday settled but tonight's NAV has not published
    // yet (before the ~18:30 ET publish cutoff). We hold Tuesday's NAV, which is the
    // freshest NAV that actually exists, so there is nothing fresher to chase: rest
    // on the market-day window instead of re-polling the identical value in a loop.
    const now = wed(22, 30);
    const ttl = navCacheTtlMs({ valueDate: "2024-01-09" }, { now });
    expect(ttl).toBe(nextSessionCloseMs(new Date(now)) - now);
  });

  it("polls once the NAV-pending window closes and the settled NAV is still missing", () => {
    // 19:30 ET Wed (past the ~18:30 publish cutoff): Wednesday's NAV is now the
    // freshest publishable NAV but we still only hold Tuesday's — fetch it now.
    const thu0030 = new Date(2024, 0, 11, 0, 30).getTime(); // 00:30 UTC Thu → 19:30 ET Wed
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, { now: thu0030 })).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("chases an unknown (uncached) value-date after the close", () => {
    expect(navCacheTtlMs(null, { now: wed(22, 30) })).toBe(DEFAULT_CACHE_TTL_MS);
    expect(navCacheTtlMs({ valueDate: null }, { now: wed(22, 30) })).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("rests before the close when the latest settled NAV is already in hand", () => {
    // 07:00 ET Wed (pre-open): the latest settled session is Tuesday (01-09),
    // which we already hold — nothing to chase. Market-day rest window from now.
    const now = wed(12);
    const ttl = navCacheTtlMs({ valueDate: "2024-01-09" }, { now });
    expect(ttl).toBe(nextSessionCloseMs(new Date(now)) - now);
  });

  it("polls when an earlier settled session's NAV is still missing", () => {
    // 07:00 ET Wed but we only hold Monday's NAV — Tuesday's (the latest settled
    // session) is missing, so fetch it now.
    const ttl = navCacheTtlMs({ valueDate: "2024-01-08" }, { now: wed(12) });
    expect(ttl).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("rests on a weekend once Friday's NAV is in hand", () => {
    // Saturday evening: latest settled session is Friday's NAV, which we hold.
    const now = sat(22);
    expect(navCacheTtlMs({ valueDate: "2024-01-12" }, { now })).toBe(
      nextSessionCloseMs(new Date(now)) - now,
    );
  });

  it("rests on the market-day window all session while the market is open", () => {
    // 15:00 UTC Wed → 10:00 ET — session open. Even holding only Tuesday's NAV
    // (tonight's has not struck yet) we rest until the next close; nothing to
    // chase mid-session.
    const wedOpen = new Date(2024, 0, 10, 15, 0).getTime();
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, { now: wedOpen })).toBe(
      nextSessionCloseMs(new Date(wedOpen)) - wedOpen,
    );
  });

  it("can be told the market is open explicitly", () => {
    // Force-open overrides the session math: rest window regardless of value-date.
    const now = wed(22, 30);
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, { now, marketOpen: true })).toBe(
      nextSessionCloseMs(new Date(now)) - now,
    );
  });

  it("honours a custom short-TTL override while behind the settled NAV", () => {
    // 19:30 ET Wed — past the NAV-publish cutoff, so Wednesday's NAV is the freshest
    // publishable value and we are genuinely behind holding only Tuesday's.
    const now = new Date(2024, 0, 11, 0, 30).getTime(); // 00:30 UTC Thu → 19:30 ET Wed
    const opts = { now, shortTtlMs: 1234, longTtlMs: 5678 };
    // Behind the latest publishable session ⇒ poll on the short window.
    expect(navCacheTtlMs({ valueDate: "2024-01-09" }, opts)).toBe(1234);
    // Holding it ⇒ market-day rest window (the longTtlMs override is now only an
    // unreachable non-positive-window guard, so the rest window wins).
    expect(navCacheTtlMs({ valueDate: "2024-01-10" }, opts)).toBe(
      nextSessionCloseMs(new Date(opts.now)) - opts.now,
    );
  });

  it("rests until the next session close when the cache timestamp is known", () => {
    // 17:30 ET Wed — closed, Wednesday settled and held. With a known `at` the
    // rest window is market-day based: it expires at the next session close
    // (Thursday 16:00 ET), not a fixed 24h after the fetch.
    const at = wed(22, 0);
    const now = wed(22, 30);
    const ttl = navCacheTtlMs({ valueDate: "2024-01-10", at }, { now });
    expect(ttl).toBe(nextSessionCloseMs(new Date(now)) - at);
  });

  it("is smart about a late NAV refreshed early the next day", () => {
    // Wednesday's NAV arrived super late — 01:00 ET Thursday (06:00 UTC) — and is
    // fetched then. A fixed 24h window would keep it 'fresh' until 06:00 UTC
    // Friday, past Thursday's close where a new NAV is due. Market-day based, it
    // instead rests only until Thursday's 16:00 ET close, then becomes due.
    const at = new Date(2024, 0, 11, 6, 0).getTime(); // 01:00 ET Thu
    const earlyThu = new Date(2024, 0, 11, 13, 0).getTime(); // 08:00 ET Thu (pre-open)
    const ttl = navCacheTtlMs({ valueDate: "2024-01-10", at }, { now: earlyThu });
    const thuClose = nextSessionCloseMs(new Date(earlyThu));
    expect(ttl).toBe(thuClose - at);
    // The entry stays fresh up to Thursday's close and not a moment past it.
    expect(earlyThu - at).toBeLessThan(ttl); // still fresh now
    expect(thuClose - at).toBe(ttl); // expires exactly at the close
  });

  it("does not force a needless weekend re-fetch", () => {
    // Friday's NAV held, fetched Friday evening; on Saturday the rest window
    // still reaches forward to Monday's close — well over 24h — so no credit is
    // wasted re-fetching an unchanged NAV over the weekend.
    const friAt = new Date(2024, 0, 12, 22, 0).getTime(); // Fri 17:00 ET
    const now = sat(22);
    const ttl = navCacheTtlMs({ valueDate: "2024-01-12", at: friAt }, { now });
    expect(ttl).toBe(nextSessionCloseMs(new Date(now)) - friAt);
    expect(ttl).toBeGreaterThan(DEFAULT_NAV_CACHE_TTL_MS); // longer than a flat 24h
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

describe("marketCacheTtlMs — adaptive market refresh", () => {
  const base = { latestSettledDate: "2024-01-10" };

  it("polls on the short window while the session is open", () => {
    expect(marketCacheTtlMs({ valueDate: "2024-01-09" }, { ...base, marketOpen: true })).toBe(DEFAULT_CACHE_TTL_MS);
    // Even already holding today's print, an open session keeps polling live.
    expect(marketCacheTtlMs({ valueDate: "2024-01-10" }, { ...base, marketOpen: true })).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("rests on the long window while closed and holding the latest close", () => {
    expect(marketCacheTtlMs({ valueDate: "2024-01-10" }, { ...base, marketOpen: false })).toBe(
      DEFAULT_CLOSED_MARKET_TTL_MS,
    );
    // A newer cached date than the latest settled session still counts as held.
    expect(marketCacheTtlMs({ valueDate: "2024-01-11" }, { ...base, marketOpen: false })).toBe(
      DEFAULT_CLOSED_MARKET_TTL_MS,
    );
  });

  it("fetches once while closed but missing the latest close", () => {
    expect(marketCacheTtlMs({ valueDate: "2024-01-09" }, { ...base, marketOpen: false })).toBe(DEFAULT_CACHE_TTL_MS);
    expect(marketCacheTtlMs(null, { ...base, marketOpen: false })).toBe(DEFAULT_CACHE_TTL_MS);
    expect(marketCacheTtlMs({ valueDate: null }, { ...base, marketOpen: false })).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("fetches once after the close when only an intraday print is held", () => {
    // Captured mid-session (is_market_open true) with today's value-date: not yet
    // the official close, so re-fetch once now that the session is shut.
    expect(
      marketCacheTtlMs({ valueDate: "2024-01-10", marketOpen: true }, { ...base, marketOpen: false }),
    ).toBe(DEFAULT_CACHE_TTL_MS);
    // A post-close capture (is_market_open false) is the settled close: rest.
    expect(
      marketCacheTtlMs({ valueDate: "2024-01-10", marketOpen: false }, { ...base, marketOpen: false }),
    ).toBe(DEFAULT_CLOSED_MARKET_TTL_MS);
    // An omitted flag is treated as a settled figure (no forced re-fetch loop).
    expect(
      marketCacheTtlMs({ valueDate: "2024-01-10", marketOpen: null }, { ...base, marketOpen: false }),
    ).toBe(DEFAULT_CLOSED_MARKET_TTL_MS);
  });

  it("honours custom short/long TTL overrides", () => {
    const opts = { ...base, marketOpen: false, shortTtlMs: 11, longTtlMs: 22 };
    expect(marketCacheTtlMs({ valueDate: "2024-01-09" }, opts)).toBe(11);
    expect(marketCacheTtlMs({ valueDate: "2024-01-10" }, opts)).toBe(22);
  });
});

describe("holdsSettledClose — settled-close detection", () => {
  const settled = "2024-01-10";
  it("holds the close when the value-date covers the settled session and not intraday", () => {
    expect(holdsSettledClose({ valueDate: "2024-01-10" }, settled)).toBe(true);
    expect(holdsSettledClose({ valueDate: "2024-01-11" }, settled)).toBe(true);
    expect(holdsSettledClose({ valueDate: "2024-01-10", marketOpen: false }, settled)).toBe(true);
    expect(holdsSettledClose({ valueDate: "2024-01-10", marketOpen: null }, settled)).toBe(true);
  });
  it("does not hold the close for an intraday-only capture or an older/absent value-date", () => {
    expect(holdsSettledClose({ valueDate: "2024-01-10", marketOpen: true }, settled)).toBe(false);
    expect(holdsSettledClose({ valueDate: "2024-01-09" }, settled)).toBe(false);
    expect(holdsSettledClose({ valueDate: null }, settled)).toBe(false);
    expect(holdsSettledClose(null, settled)).toBe(false);
  });
  it("accepts a near-close intraday print (the 21:59 rule) but not an earlier one", () => {
    // 2024-01-10 is winter (ET = UTC−5), so 15:59 ET = 20:59 UTC, 15:18 ET = 20:18 UTC.
    const nearClose = Date.UTC(2024, 0, 10, 20, 59, 0); // 15:59 ET ≈ 21:59 CET
    const earlier = Date.UTC(2024, 0, 10, 20, 18, 0); // 15:18 ET ≈ 21:18 CET
    // A print from the final minute before the bell counts as the close…
    expect(holdsSettledClose({ valueDate: "2024-01-10", marketOpen: true, priceTime: nearClose }, settled)).toBe(
      true,
    );
    // …but a mid-session print is still re-fetched once after the close.
    expect(holdsSettledClose({ valueDate: "2024-01-10", marketOpen: true, priceTime: earlier }, settled)).toBe(
      false,
    );
    // No capture time ⇒ fall back to the conservative "intraday ⇒ not the close".
    expect(holdsSettledClose({ valueDate: "2024-01-10", marketOpen: true, priceTime: null }, settled)).toBe(false);
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
    // The stamp reflects when the cached reading was originally stored, not now.
    expect(res.at).toBe(0);
  });

  it("freezes on the cached spot without spending a credit when the forex market is closed", async () => {
    const storage = memStorage();
    // A pre-today cached reading (stored t=1000ms, read +25h on a different UTC
    // day) that would normally drop to the EOD rate. With the forex market shut,
    // freeze on this last live spot instead — keeping its real prior close — and
    // never hit the wire.
    writeCachedEurUsd({ now: new Decimal("1.084"), previousClose: new Decimal("1.071") }, 1000, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const res = await loadEurUsd("key", {
      fetchImpl,
      storage,
      now: clock(90_000_000),
      ttlMs: 0,
      eodFallback: new Decimal("1.07"),
      forexOpen: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.source).toBe("cache");
    expect(res.now?.toString()).toBe("1.084");
    expect(res.previousClose?.toString()).toBe("1.071");
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
    expect(res.at).toBe(0); // mock clock starts at 0, so the fetch moment is 0
    // A genuine live pull carries an observation instant (renders as a clock).
    expect(res.observedAt).toBe(0);
    // Cached for the next call.
    const again = await loadEurUsd("key", { fetchImpl, storage, now: clock(1000), ttlMs: 60_000 });
    expect(again.source).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stamps the live FX mark at the quote's own price time, not the pull clock (plan C4)", async () => {
    const storage = memStorage();
    // The provider reports the rate's genuine strike time via `last_quote_at`
    // (Unix seconds). The FX mark must be timed to that instant, not to whenever
    // we happened to poll — otherwise the live FX tip lands at the wrong place.
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({
        symbol: "EUR/USD",
        close: "1.0900",
        previous_close: "1.0750",
        currency: "USD",
        last_quote_at: 1700,
      }),
    );
    const res = await loadEurUsd("key", { fetchImpl, storage, now: clock(50_000) });
    expect(res.source).toBe("live");
    expect(res.now?.toString()).toBe("1.09");
    // 1700 Unix seconds → 1_700_000 ms — the quote's price time, not the pull clock (50_000).
    expect(res.at).toBe(1_700_000);
    expect(res.observedAt).toBe(1_700_000);
  });

  it("keeps FX frozen over the weekend even on a forced tap", async () => {
    const storage = memStorage();
    // Hold a prior "yesterday" baseline so we can assert it survives the re-pull.
    writeCachedEurUsd({ now: new Decimal("1.084"), previousClose: new Decimal("1.071") }, 1000, storage);
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ symbol: "EUR/USD", close: "1.0930", previous_close: "1.0850", currency: "USD" }),
    );
    const res = await loadEurUsd("key", {
      fetchImpl,
      storage,
      now: clock(5000),
      ttlMs: 0,
      forexOpen: false,
      force: true,
    });
    // The forced tap still obeys the freeze: no wire hit, no indicative quote.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.source).toBe("cache");
    expect(res.now?.toString()).toBe("1.084");
    expect(res.previousClose?.toString()).toBe("1.071");
  });

  it("does not re-pull FX over the weekend freeze on an ordinary (non-forced) round", async () => {
    const storage = memStorage();
    writeCachedEurUsd({ now: new Decimal("1.084"), previousClose: new Decimal("1.071") }, 1000, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const res = await loadEurUsd("key", {
      fetchImpl,
      storage,
      now: clock(5000),
      ttlMs: 0,
      forexOpen: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.source).toBe("cache");
    expect(res.now?.toString()).toBe("1.084");
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
    // The keyless ECB rate has no intraday observation time.
    expect(res.at).toBeNull();
  });

  it("prefers an expired cached reading from today over the end-of-day rate", async () => {
    const storage = memStorage();
    // Cached at t=1000ms (1970-01-01 UTC); read at t=120_000ms (120s), still the
    // same UTC day but past the 60s TTL, so it is no longer "fresh".
    writeCachedEurUsd({ now: new Decimal("1.084"), previousClose: new Decimal("1.071") }, 1000, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const res = await loadEurUsd("", {
      fetchImpl,
      storage,
      now: clock(120_000),
      ttlMs: 60_000,
      eodFallback: new Decimal("1.07"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // Today's real intraday spot + prior close win over the flat ECB rate.
    expect(res.source).toBe("cache");
    expect(res.now?.toString()).toBe("1.084");
    expect(res.previousClose?.toString()).toBe("1.071");
  });

  it("releases the reserved credit when a transient FX failure falls back to cache", async () => {
    const storage = memStorage();
    // A cached intraday reading from earlier today, now past its TTL so a live
    // tap is attempted.
    writeCachedEurUsd({ now: new Decimal("1.10"), previousClose: new Decimal("1.09") }, 1000, storage);
    // The live leg is rejected (429): the provider never billed the credit.
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new PriceError("rate limited", { retryable: true, status: 429 });
    });
    const res = await loadEurUsd("key", {
      fetchImpl,
      storage,
      now: clock(3_600_000),
      ttlMs: 15 * 60 * 1000,
    });
    // We degrade to today's cached spot…
    expect(res.source).toBe("cache");
    // …and the reserved-but-unbilled credit is handed back, so it does not eat
    // into the same minute's quote budget (which would needlessly defer symbols).
    const spent = creditsSpentWithin(readCreditLog(3_600_000, 24 * 3600 * 1000, storage), 3_600_000, 60 * 1000);
    expect(spent).toBe(0);
  });

  it("releases the reserved Tiingo credit when the FX backup transiently fails", async () => {
    const storage = memStorage();
    // Exhaust the Twelve Data per-minute budget so the primary leg is skipped and
    // we reach the Tiingo FX backup.
    recordCredits(8, 1000, storage);
    // A same-day cached intraday reading (past its TTL) so a degrade lands on the
    // cached spot rather than the flat EOD rate — proving we fell back, not billed.
    writeCachedEurUsd({ now: new Decimal("1.10"), previousClose: new Decimal("1.095") }, 1000, storage);
    // The Tiingo backup is rejected (429): the provider never billed the credit.
    const tiingoFetchImpl = vi.fn<FetchLike>(async () => {
      throw new PriceError("rate limited", { retryable: true, status: 429 });
    });
    const res = await loadEurUsd("key", {
      fetchImpl: vi.fn<FetchLike>(),
      tiingoFetchImpl,
      storage,
      now: clock(120_000), // same UTC day, past the TTL
      ttlMs: 60_000,
      tiingoProxyUrl: "https://worker.example.dev/price",
      eodFallback: new Decimal("1.07"),
    });
    expect(tiingoFetchImpl).toHaveBeenCalledTimes(1);
    // We degrade to today's cached spot…
    expect(res.source).toBe("cache");
    // …and the reserved-but-unbilled Tiingo credit is handed back, so it does not
    // eat into the scarce hourly/daily Tiingo budget.
    const spent = tiingoCreditsSpentToday(readTiingoCreditLog(120_000, 24 * 3600 * 1000, storage), 120_000);
    expect(spent).toBe(0);
  });

  it("drops to the end-of-day rate when the cache is from before today", async () => {
    const storage = memStorage();
    // Cached on 1970-01-01 UTC; read on 1970-01-02 UTC (≈ +25h) — a different
    // calendar day, so the stale reading must not pre-empt the EOD fallback.
    writeCachedEurUsd({ now: new Decimal("1.084"), previousClose: new Decimal("1.071") }, 1000, storage);
    const fetchImpl = vi.fn<FetchLike>();
    const res = await loadEurUsd("", {
      fetchImpl,
      storage,
      now: clock(90_000_000),
      ttlMs: 60_000,
      eodFallback: new Decimal("1.07"),
    });
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

  it("falls back to Tiingo FX when the primary is over budget", async () => {
    const storage = memStorage();
    recordCredits(8, 0, storage); // exhaust the Twelve Data per-minute budget
    const primary = vi.fn<FetchLike>();
    const tiingoFetchImpl = vi.fn<FetchLike>(async (url) => {
      expect(String(url)).toContain("fx=eurusd");
      return jsonResponse([{ ticker: "eurusd", midPrice: 1.1382, quoteTimestamp: "2026-06-23T16:00:00Z" }]);
    });
    const res = await loadEurUsd("key", {
      fetchImpl: primary,
      tiingoFetchImpl,
      storage,
      now: clock(1000),
      tiingoProxyUrl: "https://worker.example.dev/price",
      eodFallback: new Decimal("1.07"),
    });
    expect(primary).not.toHaveBeenCalled(); // primary skipped (no budget)
    expect(tiingoFetchImpl).toHaveBeenCalledTimes(1);
    expect(res.source).toBe("tiingo");
    expect(res.now?.toString()).toBe("1.1382");
  });

  it("uses Tiingo FX when the primary live call fails, before the EOD rate", async () => {
    const storage = memStorage();
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (String(url).includes("fx=eurusd")) {
        return jsonResponse([{ ticker: "eurusd", midPrice: 1.14, quoteTimestamp: "2026-06-23T16:00:00Z" }]);
      }
      return jsonResponse({}, false, 500); // Twelve Data transient failure
    });
    const res = await loadEurUsd("key", {
      fetchImpl,
      storage,
      now: clock(0),
      tiingoProxyUrl: "https://worker.example.dev/price",
      eodFallback: new Decimal("1.07"),
    });
    expect(res.source).toBe("tiingo");
    expect(res.now?.toString()).toBe("1.14");
  });

  it("reuses today's cached prior close alongside a Tiingo spot", async () => {
    const storage = memStorage();
    // A same-day cached reading carries a real prior close; Tiingo carries none.
    writeCachedEurUsd({ now: new Decimal("1.10"), previousClose: new Decimal("1.095") }, 1000, storage);
    const tiingoFetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse([{ ticker: "eurusd", midPrice: 1.12, quoteTimestamp: "1970-01-01T00:02:00Z" }]),
    );
    const res = await loadEurUsd("", {
      fetchImpl: vi.fn<FetchLike>(),
      tiingoFetchImpl,
      storage,
      now: clock(120_000), // same UTC day, past the TTL
      ttlMs: 60_000,
      tiingoProxyUrl: "https://worker.example.dev/price",
      eodFallback: new Decimal("1.07"),
    });
    expect(res.source).toBe("tiingo");
    expect(res.now?.toString()).toBe("1.12");
    expect(res.previousClose?.toString()).toBe("1.095");
  });

  it("skips Tiingo FX when its budget is exhausted and drops to EOD", async () => {
    const storage = memStorage();
    recordCredits(8, 0, storage); // exhaust Twelve Data so we reach the Tiingo step
    // Exhaust the Tiingo daily cap so the FX backup is gated out.
    recordTiingoCredits(WEB_DAILY_CAP, 1000, storage);
    const tiingoFetchImpl = vi.fn<FetchLike>();
    const res = await loadEurUsd("key", {
      fetchImpl: vi.fn<FetchLike>(),
      tiingoFetchImpl,
      storage,
      now: clock(1000),
      tiingoProxyUrl: "https://worker.example.dev/price",
      eodFallback: new Decimal("1.07"),
    });
    expect(tiingoFetchImpl).not.toHaveBeenCalled();
    expect(res.source).toBe("eod");
  });
});

describe("twelveDataBudgetRemaining (graph provider-split budget, item 8)", () => {
  it("reports the full free-tier budget on an empty ledger", () => {
    const storage = memStorage();
    const { minute, day } = twelveDataBudgetRemaining(1000, { storage });
    expect(minute).toBe(8);
    expect(day).toBe(800);
  });

  it("subtracts the live shared spend (quotes-first) from the remaining budget", () => {
    const storage = memStorage();
    recordCredits(5, 1000, storage); // a quote pass just reserved 5 credits
    const { minute, day } = twelveDataBudgetRemaining(1000, { storage });
    expect(minute).toBe(3); // 8 - 5 left this minute
    expect(day).toBe(795); // 800 - 5 left today
  });

  it("never goes negative once the minute budget is exhausted", () => {
    const storage = memStorage();
    recordCredits(8, 1000, storage);
    const { minute } = twelveDataBudgetRemaining(1000, { storage });
    expect(minute).toBe(0);
  });

  it("never over-reports when a stray refund makes the ledger net negative", () => {
    const storage = memStorage();
    // A refund whose matching reservation fell outside the current window
    // (e.g. reserved just before midnight UTC, refunded just after).
    releaseCredits(3, 1000, storage);
    const { minute, day } = twelveDataBudgetRemaining(1000, { storage });
    expect(minute).toBe(8); // clamped to the cap, not 8 - (-3) = 11
    expect(day).toBe(800);
  });
});
