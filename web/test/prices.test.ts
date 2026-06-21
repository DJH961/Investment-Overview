/**
 * Tests for the price/FX layer using an injected fetch (no network).
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { convert, fetchFxRates, fetchQuotes, PriceError, type FetchLike } from "../src/prices";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

/** Run `fn`, expecting it to reject, and return the thrown PriceError. */
async function captureError(fn: () => Promise<unknown>): Promise<PriceError> {
  try {
    await fn();
  } catch (err) {
    return err as PriceError;
  }
  throw new Error("expected the call to reject");
}

describe("fetchQuotes", () => {
  it("parses a single-symbol response", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100.5", previous_close: "99.0", currency: "USD", datetime: "2024-01-10 15:30:00" });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    const vti = quotes.get("VTI")!;
    expect(vti.price?.toString()).toBe("100.5");
    expect(vti.previousClose?.toString()).toBe("99");
    expect(vti.currency).toBe("USD");
    expect(vti.valueDate).toBe("2024-01-10"); // date extracted from `datetime`
  });

  it("parses a multi-symbol response and flags per-symbol errors", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        VTI: { close: "100", previous_close: "98", currency: "USD" },
        BAD: { status: "error", message: "not found" },
      });
    const quotes = await fetchQuotes(["VTI", "BAD"], "key", fetchImpl);
    expect(quotes.get("VTI")?.price?.toString()).toBe("100");
    expect(quotes.get("BAD")?.price).toBeNull();
  });

  it("parses the price's real strike time from `timestamp` (Unix seconds → ms)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100.5", previous_close: "99.0", currency: "USD", datetime: "2024-01-10", timestamp: 1704844800 });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    // 1704844800s → ms; this is the price's own time, not "now".
    expect(quotes.get("VTI")?.priceTime).toBe(1704844800 * 1000);
  });

  it("falls back to `last_quote_at` when `timestamp` is absent", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100.5", currency: "USD", last_quote_at: 1704844800 });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    expect(quotes.get("VTI")?.priceTime).toBe(1704844800 * 1000);
  });

  it("leaves priceTime null when the API omits any usable timestamp", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100.5", currency: "USD", datetime: "2024-01-10" });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    expect(quotes.get("VTI")?.priceTime ?? null).toBeNull();
  });

  it("throws on a top-level API error", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ code: 401, status: "error", message: "bad key" });
    await expect(fetchQuotes(["VTI"], "key", fetchImpl)).rejects.toBeInstanceOf(PriceError);
  });

  it("flags a 429 response as retryable with a friendly message", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, false, 429);
    const err = await captureError(() => fetchQuotes(["VTI"], "key", fetchImpl));
    expect(err).toBeInstanceOf(PriceError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/rate limited/i);
  });

  it("treats a 5xx response as retryable but a 401 as not", async () => {
    const server = await captureError(() =>
      fetchQuotes(["VTI"], "key", async () => jsonResponse({}, false, 503)),
    );
    expect(server.retryable).toBe(true);
    const auth = await captureError(() =>
      fetchQuotes(["VTI"], "key", async () => jsonResponse({}, false, 401)),
    );
    expect(auth.retryable).toBe(false);
  });

  it("treats a network failure as retryable", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const err = await captureError(() => fetchQuotes(["VTI"], "key", fetchImpl));
    expect(err).toBeInstanceOf(PriceError);
    expect(err.retryable).toBe(true);
  });
});

describe("fetchFxRates", () => {
  it("parses rates into decimals", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ base: "EUR", rates: { USD: 1.1, GBP: 0.85 } });
    const fx = await fetchFxRates("EUR", fetchImpl);
    expect(fx.base).toBe("EUR");
    expect(fx.rates.USD.toString()).toBe("1.1");
  });
});

describe("convert", () => {
  const fx = { base: "EUR", rates: { USD: new Decimal("1.10") } };

  it("returns the amount unchanged for same currency", () => {
    expect(convert(new Decimal("100"), "EUR", "EUR", fx)?.toString()).toBe("100");
  });

  it("converts USD → EUR via the base rate", () => {
    const eur = convert(new Decimal("110"), "USD", "EUR", fx)!;
    expect(eur.toNumber()).toBeCloseTo(100, 10);
  });

  it("returns null when an FX leg is missing", () => {
    expect(convert(new Decimal("100"), "JPY", "EUR", fx)).toBeNull();
  });
});
