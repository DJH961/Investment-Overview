/**
 * Tests for the price/FX layer using an injected fetch (no network).
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { convert, fetchEurUsd, fetchFxRates, fetchNavQuotes, fetchQuotes, fetchTimeSeries, PriceError, type FetchLike } from "../src/prices";

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
      jsonResponse({ symbol: "VTI", close: "100.5", previous_close: "99.0", currency: "USD", datetime: "2024-01-10 15:30:00", is_market_open: true });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    const vti = quotes.get("VTI")!;
    expect(vti.price?.toString()).toBe("100.5");
    expect(vti.previousClose?.toString()).toBe("99");
    expect(vti.currency).toBe("USD");
    expect(vti.valueDate).toBe("2024-01-10"); // date extracted from `datetime`
    expect(vti.marketOpen).toBe(true); // provider market-state flag
  });

  it("captures a provider-reported closed market", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100", previous_close: "99", currency: "USD", is_market_open: false });
    const vti = (await fetchQuotes(["VTI"], "key", fetchImpl)).get("VTI")!;
    expect(vti.marketOpen).toBe(false);
  });

  it("leaves marketOpen null when the provider omits is_market_open", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100", previous_close: "99", currency: "USD" });
    const vti = (await fetchQuotes(["VTI"], "key", fetchImpl)).get("VTI")!;
    expect(vti.marketOpen ?? null).toBeNull();
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

  it("parses the price's real strike time from `timestamp` for an intraday bar (Unix seconds → ms)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100.5", previous_close: "99.0", currency: "USD", datetime: "2024-01-10 15:59:00", timestamp: 1704844800 });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    // 1704844800s → ms; this is the price's own time, not "now".
    expect(quotes.get("VTI")?.priceTime).toBe(1704844800 * 1000);
  });

  it("prefers `last_quote_at` over the daily-bar `timestamp` (which is the session open)", async () => {
    // The default daily `/quote` stamps `timestamp` at the bar's open (09:30 ET),
    // which a European user reads as "3:30 PM" even when pulled hours later;
    // `last_quote_at` is the genuine last-trade time and must win.
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        symbol: "VTI",
        close: "100.5",
        currency: "USD",
        datetime: "2024-01-10",
        timestamp: 1704844800, // session open
        last_quote_at: 1704880000, // genuine last trade, later in the day
      });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    expect(quotes.get("VTI")?.priceTime).toBe(1704880000 * 1000);
  });

  it("leaves priceTime null for a bare-date daily bar so a market price is dated by its fetch time", async () => {
    // `timestamp` here is the session open of a daily bar — NOT a real strike
    // time — so it must be ignored (compute then dates the price by quote.at).
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "VTI", close: "100.5", currency: "USD", datetime: "2024-01-10", timestamp: 1704844800 });
    const quotes = await fetchQuotes(["VTI"], "key", fetchImpl);
    expect(quotes.get("VTI")?.priceTime ?? null).toBeNull();
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

  it("flags 401/403 as fatal (Settings) but a 404 as a non-fatal transient gap", async () => {
    const auth = await captureError(() =>
      fetchQuotes(["VTI"], "key", async () => jsonResponse({}, false, 403)),
    );
    expect(auth.fatal).toBe(true);
    // A 404 must not dead-end the screen — non-fatal so the app keeps last-known
    // values and shows a soft banner instead.
    const notFound = await captureError(() =>
      fetchQuotes(["VTI"], "key", async () => jsonResponse({}, false, 404)),
    );
    expect(notFound.status).toBe(404);
    expect(notFound.fatal).toBe(false);
    expect(notFound.retryable).toBe(false);
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

describe("fetchNavQuotes", () => {
  it("parses the latest daily NAV bar (single symbol) as price + value-date", async () => {
    const fetchImpl: FetchLike = async (url) => {
      // Pulls from time_series, not quote, and asks for daily bars newest-first.
      expect(url).toContain("/time_series");
      expect(url).toContain("interval=1day");
      return jsonResponse({
        meta: { symbol: "FXAIX", currency: "USD" },
        values: [
          { datetime: "2024-06-20", close: "101.00" },
          { datetime: "2024-06-19", close: "100.00" },
        ],
        status: "ok",
      });
    };
    const quotes = await fetchNavQuotes(["FXAIX"], "key", fetchImpl);
    const fxaix = quotes.get("FXAIX")!;
    expect(fxaix.price?.toString()).toBe("101");
    expect(fxaix.previousClose?.toString()).toBe("100");
    expect(fxaix.currency).toBe("USD");
    expect(fxaix.valueDate).toBe("2024-06-20");
    // A daily bar has no intraday strike time → the UI shows it as a date.
    expect(fxaix.priceTime).toBeNull();
  });

  it("parses a multi-symbol time_series response and flags empty ones", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        FXAIX: { meta: { currency: "USD" }, values: [{ datetime: "2024-06-20", close: "101" }], status: "ok" },
        BAD: { status: "error", message: "not found" },
      });
    const quotes = await fetchNavQuotes(["FXAIX", "BAD"], "key", fetchImpl);
    expect(quotes.get("FXAIX")?.price?.toString()).toBe("101");
    expect(quotes.get("BAD")?.price).toBeNull();
  });

  it("rejects a whole-call error (e.g. a bad key) as a PriceError", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ code: 401, message: "bad key", status: "error" });
    const err = await captureError(() => fetchNavQuotes(["FXAIX"], "key", fetchImpl));
    expect(err).toBeInstanceOf(PriceError);
    expect(err.status).toBe(401);
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

describe("fetchEurUsd", () => {
  it("parses the live spot and prior close from the quote endpoint", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "EUR/USD", close: "1.0850", previous_close: "1.0725", currency: "USD" });
    const eurusd = await fetchEurUsd("key", fetchImpl);
    expect(eurusd.now?.toString()).toBe("1.085");
    expect(eurusd.previousClose?.toString()).toBe("1.0725");
  });

  it("returns nulls (no throw) when the pair is unavailable", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ symbol: "EUR/USD", status: "error", message: "no data" });
    const eurusd = await fetchEurUsd("key", fetchImpl);
    expect(eurusd.now).toBeNull();
    expect(eurusd.previousClose).toBeNull();
  });
});

describe("fetchTimeSeries", () => {
  it("parses a single-symbol series ascending and bills per call", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (url) => {
      calls += 1;
      expect(url).toContain("/time_series");
      expect(url).toContain("interval=5min");
      // Bars must be requested in UTC so `parseBarTime`'s UTC assumption holds
      // and price/FX/session boundaries share one clock.
      expect(url).toContain("timezone=UTC");
      return jsonResponse({
        meta: { symbol: "VTI" },
        values: [
          { datetime: "2024-01-10 16:00:00", close: "55" },
          { datetime: "2024-01-10 09:30:00", close: "50" },
        ],
      });
    };
    const series = await fetchTimeSeries(["VTI"], "key", { fetchImpl });
    const vti = series.get("VTI")!;
    expect(vti.map((b) => b.value.toString())).toEqual(["50", "55"]); // ascending
    expect(vti[0].t).toBeLessThan(vti[1].t);
    expect(calls).toBe(1); // one request for the whole day
  });

  it("parses a multi-symbol batched response", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        VTI: { values: [{ datetime: "2024-01-10 09:30:00", close: "50" }] },
        SPY: { values: [{ datetime: "2024-01-10 09:30:00", close: "400" }] },
      });
    const series = await fetchTimeSeries(["VTI", "SPY"], "key", { fetchImpl });
    expect(series.get("VTI")![0].value.toString()).toBe("50");
    expect(series.get("SPY")![0].value.toString()).toBe("400");
  });

  it("returns an empty series for a symbol the feed errored on", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        VTI: { values: [{ datetime: "2024-01-10 09:30:00", close: "50" }] },
        BAD: { status: "error", message: "no data" },
      });
    const series = await fetchTimeSeries(["VTI", "BAD"], "key", { fetchImpl });
    expect(series.get("BAD")).toEqual([]);
  });

  it("throws a fatal PriceError on a rejected key", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ status: "error", code: 401, message: "bad key" });
    const err = await captureError(() => fetchTimeSeries(["VTI"], "key", { fetchImpl }));
    expect(err.fatal).toBe(true);
  });

  it("returns an empty map for no symbols without calling the network", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return jsonResponse({});
    };
    expect((await fetchTimeSeries([], "key", { fetchImpl })).size).toBe(0);
    expect(called).toBe(false);
  });
});
