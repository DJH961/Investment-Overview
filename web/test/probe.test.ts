/**
 * Tests for the diagnostic quote probe (`probe.ts`). A stub fetch returns canned
 * provider payloads (or throws) so every verdict path is exercised offline.
 */
import { describe, expect, it } from "vitest";

import {
  decideProbeGate,
  formatProbeReport,
  probeHeadline,
  probeLogLine,
  probeProviderLabel,
  probeQuote,
  probeSucceeded,
  type ProbeProvider,
} from "../src/probe";
import type { FetchLike } from "../src/prices";

const API_KEY = "secret-key-123";
const PROXY = "https://worker.example.dev/price";

/** Build a Response-like stub whose `.text()` yields `body` (a string or JSON). */
function textResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "",
    text: async () => text,
  } as unknown as Response;
}

/** A fetch stub that records the URL it was called with and returns `resp`. */
function stubFetch(resp: Response | (() => Response)): { fetchImpl: FetchLike; lastUrl: () => string } {
  let lastUrl = "";
  const fetchImpl: FetchLike = async (url) => {
    lastUrl = String(url);
    return typeof resp === "function" ? resp() : resp;
  };
  return { fetchImpl, lastUrl: () => lastUrl };
}

describe("probeQuote — Twelve Data", () => {
  it("parses a healthy single-symbol quote", async () => {
    const { fetchImpl, lastUrl } = stubFetch(
      textResponse({ symbol: "AAPL", close: "206.15", previous_close: "205.0", currency: "USD" }),
    );
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("ok");
    expect(out.price).toBe("206.15");
    expect(out.previousClose).toBe("205.0");
    expect(out.currency).toBe("USD");
    expect(probeSucceeded(out)).toBe(true);
    expect(lastUrl()).toContain("symbol=AAPL");
    expect(lastUrl()).toContain(`apikey=${API_KEY}`);
  });

  it("redacts the API key from the reported URL (never the real key)", async () => {
    const { fetchImpl } = stubFetch(textResponse({ symbol: "AAPL", close: "1" }));
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.requestUrl).toContain("apikey=***redacted***");
    expect(out.requestUrl).not.toContain(API_KEY);
    expect(formatProbeReport(out)).not.toContain(API_KEY);
  });

  it("flags a missing API key as not-configured without fetching", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return textResponse({});
    };
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: "", fetchImpl });
    expect(out.verdict).toBe("not-configured");
    expect(out.reached).toBe(false);
    expect(called).toBe(false);
  });

  it("classifies a 401 HTTP status as a bad key", async () => {
    const { fetchImpl } = stubFetch(textResponse("Unauthorized", { ok: false, status: 401 }));
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("bad-key");
    expect(out.httpStatus).toBe(401);
    expect(out.detail).toMatch(/key/i);
  });

  it("classifies a top-level 401 error body (200 OK) as a bad key", async () => {
    const { fetchImpl } = stubFetch(
      textResponse({ code: 401, message: "Invalid API key", status: "error" }),
    );
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("bad-key");
    expect(out.detail).toContain("Invalid API key");
  });

  it("classifies a 429 as rate-limited", async () => {
    const { fetchImpl } = stubFetch(textResponse("Too Many Requests", { ok: false, status: 429 }));
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("rate-limited");
  });

  it("classifies a 5xx as a server error", async () => {
    const { fetchImpl } = stubFetch(textResponse("Bad Gateway", { ok: false, status: 502 }));
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("server-error");
  });

  it("reports no-quote when the body has no usable price", async () => {
    const { fetchImpl } = stubFetch(textResponse({ symbol: "ZZZZ", close: null }));
    const out = await probeQuote({ provider: "twelvedata", symbol: "ZZZZ", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("no-quote");
  });

  it("captures a transport failure as unreachable (never throws)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("Failed to fetch");
    };
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("unreachable");
    expect(out.reached).toBe(false);
    expect(out.rawBody).toContain("Failed to fetch");
  });

  it("flags a 200 with non-JSON body as bad-response", async () => {
    const { fetchImpl } = stubFetch(textResponse("<html>not json</html>"));
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(out.verdict).toBe("bad-response");
  });
});

describe("probeQuote — Tiingo", () => {
  it("parses a healthy IEX row", async () => {
    const { fetchImpl, lastUrl } = stubFetch(
      textResponse([{ ticker: "AAPL", tngoLast: 206.15, prevClose: 205.0 }]),
    );
    const out = await probeQuote({ provider: "tiingo", symbol: "AAPL", proxyUrl: PROXY, fetchImpl });
    expect(out.verdict).toBe("ok");
    expect(out.price).toBe("206.15");
    expect(out.previousClose).toBe("205");
    expect(out.currency).toBe("USD");
    expect(lastUrl()).toContain("tickers=AAPL");
  });

  it("matches the requested symbol case-insensitively", async () => {
    const { fetchImpl } = stubFetch(textResponse([{ ticker: "AAPL", tngoLast: 1.5 }]));
    const out = await probeQuote({ provider: "tiingo", symbol: "aapl", proxyUrl: PROXY, fetchImpl });
    expect(out.verdict).toBe("ok");
    expect(out.price).toBe("1.5");
  });

  it("flags a missing proxy URL as not-configured", async () => {
    const out = await probeQuote({ provider: "tiingo", symbol: "AAPL", proxyUrl: "" });
    expect(out.verdict).toBe("not-configured");
    expect(out.reached).toBe(false);
  });

  it("treats a non-array 200 body as a misconfigured proxy (bad-response)", async () => {
    const { fetchImpl } = stubFetch(textResponse({ error: "not an array" }));
    const out = await probeQuote({ provider: "tiingo", symbol: "AAPL", proxyUrl: PROXY, fetchImpl });
    expect(out.verdict).toBe("bad-response");
    expect(out.detail).toMatch(/proxy|Worker/i);
  });

  it("reports no-quote for an empty array", async () => {
    const { fetchImpl } = stubFetch(textResponse([]));
    const out = await probeQuote({ provider: "tiingo", symbol: "AAPL", proxyUrl: PROXY, fetchImpl });
    expect(out.verdict).toBe("no-quote");
  });

  it("classifies a 429 from the proxy as rate-limited", async () => {
    const { fetchImpl } = stubFetch(textResponse("rate limited", { ok: false, status: 429 }));
    const out = await probeQuote({ provider: "tiingo", symbol: "AAPL", proxyUrl: PROXY, fetchImpl });
    expect(out.verdict).toBe("rate-limited");
  });
});

describe("probe formatting helpers", () => {
  it("labels providers", () => {
    expect(probeProviderLabel("twelvedata")).toMatch(/Twelve Data/);
    expect(probeProviderLabel("tiingo")).toMatch(/Tiingo/);
  });

  it("builds a headline and log line", async () => {
    const { fetchImpl } = stubFetch(textResponse({ symbol: "AAPL", close: "1", currency: "USD" }));
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    expect(probeHeadline(out)).toContain("AAPL");
    expect(probeLogLine(out)).toContain("Probe");
  });

  it("includes the raw body in the formatted report", async () => {
    const { fetchImpl } = stubFetch(textResponse({ symbol: "AAPL", close: "1" }));
    const out = await probeQuote({ provider: "twelvedata", symbol: "AAPL", apiKey: API_KEY, fetchImpl });
    const report = formatProbeReport(out);
    expect(report).toContain("Raw response:");
    expect(report).toContain('"symbol"');
  });

  it("truncates an oversized body", async () => {
    const big = "x".repeat(10_000);
    const { fetchImpl } = stubFetch(textResponse(big));
    const out = await probeQuote({
      provider: "twelvedata",
      symbol: "AAPL",
      apiKey: API_KEY,
      fetchImpl,
      maxBodyChars: 100,
    });
    expect(out.rawBody).toMatch(/truncated/);
    expect((out.rawBody ?? "").length).toBeLessThan(big.length);
  });
});

describe("decideProbeGate", () => {
  it("is ready when Twelve Data has budget and a clear minute window", () => {
    expect(decideProbeGate({ provider: "twelvedata", available: 8, minuteReadyDelayMs: 0 })).toEqual({
      kind: "ready",
    });
  });

  it("waits for the Twelve Data minute window when it is not clear", () => {
    const d = decideProbeGate({ provider: "twelvedata", available: 8, minuteReadyDelayMs: 12000 });
    expect(d).toEqual({ kind: "wait", delayMs: 12000 });
  });

  it("is over-limit when Twelve Data has no credits and a clear window", () => {
    const d = decideProbeGate({ provider: "twelvedata", available: 0, minuteReadyDelayMs: 0 });
    expect(d.kind).toBe("over-limit");
  });

  it("treats a frozen Twelve Data as over-limit, never a short wait", () => {
    const d = decideProbeGate({ provider: "twelvedata", available: 0, minuteReadyDelayMs: 30000, frozen: true });
    expect(d.kind).toBe("over-limit");
    if (d.kind === "over-limit") expect(d.reason).toMatch(/frozen/i);
  });

  it("gates Tiingo purely on its hour/day budget (no minute window)", () => {
    expect(decideProbeGate({ provider: "tiingo", available: 5, minuteReadyDelayMs: 0 }).kind).toBe("ready");
    expect(decideProbeGate({ provider: "tiingo", available: 0, minuteReadyDelayMs: 0 }).kind).toBe("over-limit");
  });

  it("treats a frozen Tiingo as over-limit", () => {
    const d = decideProbeGate({ provider: "tiingo", available: 3, minuteReadyDelayMs: 0, frozen: true });
    expect(d.kind).toBe("over-limit");
  });
});

describe("provider matrix", () => {
  const providers: ProbeProvider[] = ["twelvedata", "tiingo"];
  it.each(providers)("never throws for %s on a dead transport", async (provider) => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("boom");
    };
    const out = await probeQuote({ provider, symbol: "AAPL", apiKey: API_KEY, proxyUrl: PROXY, fetchImpl });
    expect(out.verdict).toBe("unreachable");
  });
});
