/**
 * Tests for the Cloudflare Worker `/price` route (`web/proxy/worker.js`),
 * focusing on the FX (`?fx=eurusd`) branch added for the Tiingo backup live FX
 * provider. The upstream `fetch` is stubbed so we can assert the pinned URL the
 * Worker builds and that the token rides the `Authorization` header (never the
 * URL).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error — plain JS Worker module, no types.
import worker from "../proxy/worker.js";

const ENV = { TIINGO_TOKEN: "test-token" };

function stubUpstream(body: unknown, status = 200): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker /price fx route", () => {
  it("builds the pinned Tiingo FX top-of-book URL and injects the token as a header", async () => {
    const { calls } = stubUpstream([{ ticker: "eurusd", midPrice: 1.1382 }]);
    const resp = await worker.fetch(new Request("https://w.example.dev/price?fx=eurusd"), ENV);
    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.tiingo.com/tiingo/fx/top?tickers=eurusd");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Token test-token");
    // Token never leaks into the upstream URL.
    expect(calls[0].url.toLowerCase()).not.toContain("token");
  });

  it("rejects a malformed fx pair without hitting the upstream", async () => {
    const { calls } = stubUpstream([]);
    const resp = await worker.fetch(new Request("https://w.example.dev/price?fx=eur/usd"), ENV);
    expect(resp.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("503s when no Tiingo token is configured", async () => {
    stubUpstream([]);
    const resp = await worker.fetch(new Request("https://w.example.dev/price?fx=eurusd"), {});
    expect(resp.status).toBe(503);
  });

  it("still serves the IEX quote route unchanged", async () => {
    const { calls } = stubUpstream([{ ticker: "AAPL", tngoLast: 200 }]);
    await worker.fetch(new Request("https://w.example.dev/price?tickers=AAPL"), ENV);
    expect(calls[0].url).toBe("https://api.tiingo.com/iex/?tickers=AAPL");
  });
});
