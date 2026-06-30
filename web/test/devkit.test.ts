/**
 * Tests for the devkit data-pulling harness. These both verify the harness and
 * double as the smallest worked examples of how to drive it from a test.
 */
import { describe, expect, it } from "vitest";

import { FakeProvider } from "../src/devkit/fake-provider";
import { MemoryStorage, runScenario, formatResult, type Scenario } from "../src/devkit/harness";
import { SCENARIOS, findScenario } from "../src/devkit/scenarios";
import { nextRefreshDelayMs } from "../src/refresh-policy";

const NOW = Date.parse("2024-01-10T15:00:00Z");

describe("FakeProvider routing + ledger", () => {
  it("routes Twelve Data /quote and records one credit per symbol", async () => {
    const provider = new FakeProvider({
      twelveData: { quotes: { AAPL: { close: "190", currency: "USD" }, MSFT: { close: "410", currency: "USD" } } },
    });
    const resp = await provider.fetch("https://api.twelvedata.com/quote?symbol=AAPL,MSFT&apikey=x");
    const body = (await resp.json()) as Record<string, { close: string }>;
    expect(body.AAPL.close).toBe("190");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].kind).toBe("td-quote");
    expect(provider.requests[0].symbols).toEqual(["AAPL", "MSFT"]);
    expect(provider.totalCreditsImplied()).toBe(2);
  });

  it("returns a bodyless 304 when the conditional ETag matches", async () => {
    const provider = new FakeProvider({
      blob: { url: "https://blob/x.enc", envelope: sampleEnvelope(), etag: '"v1"' },
    });
    const resp = await provider.fetch("https://blob/x.enc", { headers: { "If-None-Match": '"v1"' } });
    expect(resp.status).toBe(304);
    expect(provider.requests[0].conditional).toEqual({ ifNoneMatch: '"v1"' });
  });

  it("serves the envelope with validators when no conditional matches", async () => {
    const provider = new FakeProvider({
      blob: { url: "https://blob/x.enc", envelope: sampleEnvelope(), etag: '"v2"' },
    });
    const resp = await provider.fetch("https://blob/x.enc", { headers: { "If-None-Match": '"v1"' } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("ETag")).toBe('"v2"');
  });

  it("answers an over-quota error as a top-level Twelve Data error body", async () => {
    const provider = new FakeProvider({ twelveData: { error: { code: 429, message: "too many" } } });
    const resp = await provider.fetch("https://api.twelvedata.com/quote?symbol=AAPL&apikey=x");
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { code: number };
    expect(body.code).toBe(429);
  });
});

describe("MemoryStorage", () => {
  it("behaves like Web Storage and exposes a dump", () => {
    const s = new MemoryStorage();
    s.setItem("a", "1");
    expect(s.getItem("a")).toBe("1");
    s.removeItem("a");
    expect(s.getItem("a")).toBeNull();
    s.setItem("b", "2");
    expect(s.dump()).toEqual({ b: "2" });
  });
});

describe("runScenario", () => {
  it("evaluates the pull plan without touching the network", async () => {
    const scenario: Scenario = {
      name: "plan-only",
      nowMs: NOW,
      plan: {
        kind: "reset",
        nowMs: NOW,
        market: "closed",
        minutesSinceOpenMs: 0,
        autoIntervalMs: 300000,
        freshness: { dataAgeMs: 0, deviceDaysMissing: 0, blobDaysOld: 0, quoteAgeMs: 0, navHeldForToday: true },
        barGate: { lastBarPullMs: null, sessionOpenMs: NOW },
      },
    };
    const result = await runScenario(scenario);
    expect(result.plan?.tier).toBe("outdated");
    expect(result.requests).toHaveLength(0);
  });

  it("runs the real quote fetcher against the fake and reports the pull", async () => {
    const scenario: Scenario = {
      name: "quote-run",
      nowMs: NOW,
      provider: { twelveData: { quotes: { AAPL: { close: "190", previous_close: "188", currency: "USD" } } } },
      run: { kind: "quotes", symbols: ["AAPL"], options: { forceMarketFetch: true } },
    };
    const result = await runScenario(scenario);
    expect(result.quotes?.[0]).toMatchObject({ symbol: "AAPL", price: "190", source: "fetched" });
    expect(result.creditsImplied).toBe(1);
    expect(result.quoteReport?.fetched).toEqual(["AAPL"]);
  });

  it("defers symbols once the daily credit budget is exhausted", async () => {
    const result = await runScenario(findScenario("near-budget")!);
    expect(result.quotes?.filter((q) => q.source === "deferred")).toHaveLength(2);
    expect(result.creditsImplied).toBe(1);
  });

  it("standard manual Refresh in a closed, fully-cached market distrusts the cache: 8 fetch now, 6 defer, none skipped", async () => {
    // This is the STANDARD Refresh button (not the "Force-fetch every price now"
    // escape hatch). In the `settled` phase (market shut + every NAV in hand) the
    // manual tap escalates to `forceAll`, which `App.buildQuoteOptions` turns into
    // `forceFetch: () => true` — the very option this scenario runs. So a manual
    // push in a closed market re-pulls the whole book rather than trusting cache.
    const result = await runScenario(findScenario("forced-closed-defer")!);
    const r = result.quoteReport!;
    // The per-minute cap (8) fetches the first 8 and defers the overflow…
    expect(r.fetched).toHaveLength(8);
    expect(r.deferred).toHaveLength(6);
    // …in deterministic incoming (size-priority) order: the first 8 land, the
    // last 6 wait — so the overflow is the tail of the list, never a fresh skip.
    const run = result.scenario.run;
    const all = run?.kind === "quotes" ? run.symbols : [];
    expect(r.fetched).toEqual(all.slice(0, 8));
    expect(r.deferred).toEqual(all.slice(8));
    // …and crucially nothing is served from cache: a manual distrust pull never
    // skips a symbol just because its cached close is still fresh.
    expect(r.servedFresh).toHaveLength(0);
    expect(result.creditsImplied).toBe(8);
    expect(r.minuteRemaining).toBe(0);

    // The next auto-refresh fires after exactly one minute (the per-minute credit
    // window) so the 6 deferred symbols are picked up promptly — no slower.
    const burstMs = nextRefreshDelayMs({ deferred: r.deferred, dayRemaining: r.dayRemaining }, { jitterMs: 0 });
    expect(burstMs).toBe(60_000);
  });

  it("falls back to cache and reports the error on a 429", async () => {
    const result = await runScenario(findScenario("td-429")!);
    expect(result.quoteReport?.error?.status).toBe(429);
    expect(result.quotes?.[0]).toMatchObject({ symbol: "AAPL", source: "failed", price: "189" });
  });

  it("revalidates the blob to a 304 when the cached ETag still matches", async () => {
    const result = await runScenario(findScenario("blob-304")!);
    expect(result.blob).toEqual({ status: "not-modified", usedConditional: true });
  });
});

describe("built-in scenarios", () => {
  it("every scenario runs and formats without throwing", async () => {
    for (const scenario of SCENARIOS) {
      const result = await runScenario(scenario);
      expect(typeof formatResult(result)).toBe("string");
    }
  });

  it("has unique names", () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

function sampleEnvelope() {
  return {
    v: 1,
    kdf: "PBKDF2-HMAC-SHA256",
    kdf_params: { salt: "ZGV2a2l0LXNhbHQtMTY=", iterations: 600000 },
    nonce: "ZGV2a2l0LW5vbmNl",
    ciphertext: "ZGV2a2l0LWNpcGhlcnRleHQ=",
    tag: "ZGV2a2l0LXRhZy0xMjM0NTY3OA==",
  };
}
