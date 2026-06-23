/**
 * Tests for the Cloudflare Worker (`web/proxy/worker.js`) unified `/price` route:
 * the `?intraday=` 1-hour bars branch, the `?daily=` daily-range branch,
 * the FX branches (`?fx=eurusd` live + `?fxHistory=eurusd` history), and
 * the per-isolate hourly Tiingo budget (429 + Retry-After). The
 * upstream `fetch` is stubbed so no network is touched; we assert on the exact
 * pinned URL the Worker builds, the injected `Authorization` header, and that
 * caller input is charset-validated (no SSRF, no open proxy).
 *
 * Each test loads a *fresh* module instance (`vi.resetModules`) so the Worker's
 * per-isolate in-memory budget counter starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "../proxy/worker.js";

const ORIGIN = "https://proxy.example.dev";
const ENV: WorkerEnv = { TIINGO_TOKEN: "secret-token" };

const stubUpstreamHolder: { current: { calls: { url: string; init: RequestInit }[] } } = {
  current: { calls: [] },
};

/** Load a pristine Worker instance with an empty per-isolate budget. */
async function loadWorker() {
  vi.resetModules();
  const mod = await import("../proxy/worker.js");
  return mod.default;
}

/** Record every upstream fetch and return a canned JSON 200. */
function stubUpstream(): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify([{ close: 1 }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

beforeEach(() => {
  stubUpstreamHolder.current = stubUpstream();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/price intraday branch", () => {
  it("proxies to the pinned IEX 1-hour bars endpoint with the injected token", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const res = await worker.fetch(
      new Request(`${ORIGIN}/price?intraday=AAPL&startDate=2026-06-22&endDate=2026-06-23`),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(calls).toHaveLength(1);

    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.tiingo.com/iex/AAPL/prices");
    // The intraday branch pins the bar width server-side (not caller-controlled).
    expect(url.searchParams.get("resampleFreq")).toBe("1hour");
    expect(url.searchParams.get("startDate")).toBe("2026-06-22");
    expect(url.searchParams.get("endDate")).toBe("2026-06-23");
    // Token rides the Authorization header, never the URL.
    expect(url.search).not.toContain("secret-token");
    const auth = new Headers(calls[0].init.headers).get("Authorization");
    expect(auth).toBe("Token secret-token");
  });

  it("rejects a bad intraday ticker without hitting upstream (no SSRF)", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const res = await worker.fetch(new Request(`${ORIGIN}/price?intraday=../evil`), ENV);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid intraday date", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const res = await worker.fetch(
      new Request(`${ORIGIN}/price?intraday=AAPL&startDate=2026-6-2`),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 503 when the token is not configured", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(new Request(`${ORIGIN}/price?intraday=AAPL`), {});
    expect(res.status).toBe(503);
  });

  it("answers CORS preflight", async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(new Request(`${ORIGIN}/price`, { method: "OPTIONS" }), ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("/price daily branch honors the range", () => {
  it("forwards resampleFreq=daily and the startDate/endDate window", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    await worker.fetch(
      new Request(`${ORIGIN}/price?daily=VOO&startDate=2026-01-01&endDate=2026-06-01`),
      ENV,
    );
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.tiingo.com/tiingo/daily/VOO/prices");
    expect(url.searchParams.get("resampleFreq")).toBe("daily");
    expect(url.searchParams.get("startDate")).toBe("2026-01-01");
    expect(url.searchParams.get("endDate")).toBe("2026-06-01");
  });
});

describe("hourly Tiingo reserve", () => {
  it("returns 429 with Retry-After once the per-isolate reserve is spent", async () => {
    const worker = await loadWorker();
    const env: WorkerEnv = { TIINGO_TOKEN: "secret-token", TIINGO_HOURLY_RESERVE: "3" };
    const hit = () => worker.fetch(new Request(`${ORIGIN}/price?intraday=AAPL`), env);

    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);

    const limited = await hit();
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("counts every /price branch against the same reserve", async () => {
    const worker = await loadWorker();
    const env: WorkerEnv = { TIINGO_TOKEN: "secret-token", TIINGO_HOURLY_RESERVE: "2" };
    expect((await worker.fetch(new Request(`${ORIGIN}/price?tickers=AAPL`), env)).status).toBe(200);
    expect(
      (await worker.fetch(new Request(`${ORIGIN}/price?intraday=AAPL`), env)).status,
    ).toBe(200);
    expect((await worker.fetch(new Request(`${ORIGIN}/price?tickers=MSFT`), env)).status).toBe(429);
  });
});

describe("/price fx route (live top-of-book)", () => {
  it("builds the pinned Tiingo FX top-of-book URL and injects the token as a header", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const resp = await worker.fetch(new Request(`${ORIGIN}/price?fx=eurusd`), ENV);
    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.tiingo.com/tiingo/fx/top?tickers=eurusd");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Token secret-token");
    // Token never leaks into the upstream URL.
    expect(calls[0].url.toLowerCase()).not.toContain("secret-token");
  });

  it("rejects a malformed fx pair without hitting the upstream", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const resp = await worker.fetch(new Request(`${ORIGIN}/price?fx=eur/usd`), ENV);
    expect(resp.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("503s when no Tiingo token is configured", async () => {
    const worker = await loadWorker();
    const resp = await worker.fetch(new Request(`${ORIGIN}/price?fx=eurusd`), {});
    expect(resp.status).toBe(503);
  });

  it("still serves the IEX quote route unchanged", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    await worker.fetch(new Request(`${ORIGIN}/price?tickers=AAPL`), ENV);
    expect(calls[0].url).toBe("https://api.tiingo.com/iex/?tickers=AAPL");
  });
});

describe("/price fxHistory route (history backfill)", () => {
  it("builds the pinned Tiingo FX daily-history URL over the requested window", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const resp = await worker.fetch(
      new Request(`${ORIGIN}/price?fxHistory=eurusd&startDate=2026-06-01&endDate=2026-06-23`),
      ENV,
    );
    expect(resp.status).toBe(200);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.tiingo.com/tiingo/fx/eurusd/prices");
    expect(url.searchParams.get("resampleFreq")).toBe("1day");
    expect(url.searchParams.get("startDate")).toBe("2026-06-01");
    expect(url.searchParams.get("endDate")).toBe("2026-06-23");
    expect(url.search).not.toContain("secret-token");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Token secret-token");
  });

  it("forwards an intraday resampleFreq (1hour) for the 1D graph FX", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    await worker.fetch(
      new Request(`${ORIGIN}/price?fxHistory=eurusd&resampleFreq=1hour`),
      ENV,
    );
    expect(new URL(calls[0].url).searchParams.get("resampleFreq")).toBe("1hour");
  });

  it("rejects an invalid resampleFreq", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const resp = await worker.fetch(
      new Request(`${ORIGIN}/price?fxHistory=eurusd&resampleFreq=1week`),
      ENV,
    );
    expect(resp.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed fxHistory pair without hitting the upstream", async () => {
    const worker = await loadWorker();
    const calls = stubUpstreamHolder.current.calls;
    const resp = await worker.fetch(new Request(`${ORIGIN}/price?fxHistory=eur1usd`), ENV);
    expect(resp.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("counts against the shared hourly reserve", async () => {
    const worker = await loadWorker();
    const env: WorkerEnv = { TIINGO_TOKEN: "secret-token", TIINGO_HOURLY_RESERVE: "1" };
    expect((await worker.fetch(new Request(`${ORIGIN}/price?fxHistory=eurusd`), env)).status).toBe(
      200,
    );
    expect((await worker.fetch(new Request(`${ORIGIN}/price?fx=eurusd`), env)).status).toBe(429);
  });
});
