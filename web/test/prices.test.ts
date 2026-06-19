/**
 * Tests for the price/FX layer using an injected fetch (no network).
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { convert, fetchFxRates, fetchQuotes, PriceError, type FetchLike } from "../src/prices";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe("fetchQuotes", () => {
  it("parses a single-symbol response", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100.5", previous_close: "99.0", currency: "USD" });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    const vti = quotes.get("VTI")!;
    expect(vti.price?.toString()).toBe("100.5");
    expect(vti.previousClose?.toString()).toBe("99");
    expect(vti.currency).toBe("USD");
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

  it("throws on a top-level API error", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ code: 401, status: "error", message: "bad key" });
    await expect(fetchQuotes(["VTI"], "key", fetchImpl)).rejects.toBeInstanceOf(PriceError);
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
