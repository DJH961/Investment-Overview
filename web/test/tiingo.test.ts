/**
 * Tests for the Tiingo IEX client (`tiingo.ts`) that talks to the `/price`
 * Worker proxy. A stub fetch returns canned IEX payloads.
 */
import { describe, expect, it } from "vitest";

import {
  fetchTiingoEurUsd,
  fetchTiingoFxBars,
  fetchTiingoQuotes,
} from "../src/tiingo";
import { makeTiingoBarFetcher } from "../src/intraday-tiingo";
import { PriceError, type FetchLike } from "../src/prices";

const PROXY = "https://worker.example.dev/price";

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe("fetchTiingoQuotes", () => {
  it("requests the proxy with a comma-joined ticker list", async () => {
    let calledUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      calledUrl = String(url);
      return jsonResponse([]);
    };
    await fetchTiingoQuotes(["AAPL", "MSFT"], PROXY, { fetchImpl });
    expect(calledUrl).toContain("tickers=AAPL%2CMSFT");
    expect(calledUrl.startsWith(PROXY)).toBe(true);
  });

  it("parses an equity row into a live-timestamped quote", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([
        { ticker: "AAPL", tngoLast: 206.15, prevClose: 205.0, timestamp: "2026-06-22T15:59:00-04:00" },
      ]);
    const quotes = await fetchTiingoQuotes(["AAPL"], PROXY, { fetchImpl });
    const q = quotes.get("AAPL");
    expect(q?.price?.toString()).toBe("206.15");
    expect(q?.previousClose?.toString()).toBe("205");
    expect(q?.currency).toBe("USD");
    expect(q?.valueDate).toBe("2026-06-22");
    expect(q?.priceTime).not.toBeNull(); // equity keeps a real intraday strike time
  });

  it("dates a NAV fund by value-date with no faux-live strike time", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([
        { ticker: "FSKAX", tngoLast: 206.15, prevClose: 206.85, timestamp: "2026-06-22T18:30:00-04:00" },
      ]);
    const quotes = await fetchTiingoQuotes(["FSKAX"], PROXY, {
      fetchImpl,
      navSymbols: new Set(["FSKAX"]),
    });
    const q = quotes.get("FSKAX");
    expect(q?.price?.toString()).toBe("206.15");
    expect(q?.valueDate).toBe("2026-06-22");
    expect(q?.priceTime).toBeNull(); // NAV → settled, not faux-live
  });

  it("omits a row that has only a prevClose and no live mark (aligned with desktop)", async () => {
    // `prevClose` is NOT part of the price fallback chain: a row carrying only
    // yesterday's close (no `tngoLast`/`last`) is unusable as a live price, so
    // the symbol comes back absent rather than valued at a stale number.
    const fetchImpl: FetchLike = async () =>
      jsonResponse([{ ticker: "VOO", prevClose: 500.0, timestamp: "2026-06-22T15:59:00-04:00" }]);
    const quotes = await fetchTiingoQuotes(["VOO"], PROXY, { fetchImpl });
    expect(quotes.has("VOO")).toBe(false);
  });

  it("rejects a non-positive provider price as missing", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([{ ticker: "ZERO", tngoLast: 0, timestamp: "2026-06-22T15:59:00-04:00" }]);
    const quotes = await fetchTiingoQuotes(["ZERO"], PROXY, { fetchImpl });
    expect(quotes.has("ZERO")).toBe(false);
  });

  it("reads the live strike time from lastSaleTimestamp when timestamp is absent", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([{ ticker: "AAPL", tngoLast: 206.15, lastSaleTimestamp: "2026-06-22T15:59:00-04:00" }]);
    const quotes = await fetchTiingoQuotes(["AAPL"], PROXY, { fetchImpl });
    expect(quotes.get("AAPL")?.valueDate).toBe("2026-06-22");
    expect(quotes.get("AAPL")?.priceTime).not.toBeNull();
  });

  it("resolves an upper-cased provider ticker back to a lower/mixed-case requested symbol", async () => {
    // The export's price_symbol may be lower/mixed case; Tiingo always upper-cases
    // its echo. The result must still be keyed by the requested symbol so the
    // caller's `quotes.get(price_symbol)` fallback merge finds it.
    const fetchImpl: FetchLike = async () =>
      jsonResponse([{ ticker: "VOO", tngoLast: 500.0, timestamp: "2026-06-22T15:59:00-04:00" }]);
    const quotes = await fetchTiingoQuotes(["voo"], PROXY, { fetchImpl });
    expect(quotes.get("voo")?.price?.toString()).toBe("500");
    expect(quotes.has("VOO")).toBe(false);
  });

  it("throws a PriceError when the proxy returns a non-array body (blob/error object)", async () => {
    // The deployed Worker missing its `/price` route serves the encrypted blob (a
    // JSON *object*) on `/price`; a bad upstream relays a Tiingo error object.
    // Either way it is not a Tiingo quote array, so treat it as a visible failure.
    const fetchImpl: FetchLike = async () => jsonResponse({ status: "error", message: "bad token" });
    await expect(fetchTiingoQuotes(["AAPL"], PROXY, { fetchImpl })).rejects.toMatchObject({
      name: "PriceError",
      retryable: false,
    });
  });

  it("throws a classified PriceError on a non-OK HTTP status", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, { ok: false, status: 429 });
    await expect(fetchTiingoQuotes(["AAPL"], PROXY, { fetchImpl })).rejects.toMatchObject({
      name: "PriceError",
      retryable: true,
    });
  });

  it("is a no-op for an empty symbol list or missing proxy", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return jsonResponse([]);
    };
    expect((await fetchTiingoQuotes([], PROXY, { fetchImpl })).size).toBe(0);
    expect((await fetchTiingoQuotes(["AAPL"], "", { fetchImpl })).size).toBe(0);
    expect(called).toBe(false);
  });

  it("wraps a transport failure as a retryable PriceError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(fetchTiingoQuotes(["AAPL"], PROXY, { fetchImpl })).rejects.toBeInstanceOf(PriceError);
  });
});

describe("fetchTiingoEurUsd", () => {
  it("requests the proxy with fx=eurusd and returns the mid directly", async () => {
    let calledUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      calledUrl = String(url);
      return jsonResponse([
        { ticker: "eurusd", bidPrice: 1.13818, askPrice: 1.13819, midPrice: 1.138185, quoteTimestamp: "2026-06-23T16:06:52.450Z" },
      ]);
    };
    const reading = await fetchTiingoEurUsd(PROXY, { fetchImpl });
    expect(calledUrl).toContain("fx=eurusd");
    expect(reading?.now.toString()).toBe("1.138185");
    expect(reading?.at).toBe(Date.parse("2026-06-23T16:06:52.450Z"));
  });

  it("falls back to the bid/ask midpoint when midPrice is absent", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([{ ticker: "eurusd", bidPrice: 1.1, askPrice: 1.2 }]);
    const reading = await fetchTiingoEurUsd(PROXY, { fetchImpl });
    expect(reading?.now.toString()).toBe("1.15");
  });

  it("returns null for an empty array (unquoted/weekend pair)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse([]);
    expect(await fetchTiingoEurUsd(PROXY, { fetchImpl })).toBeNull();
  });

  it("throws when the proxy returns a non-array (un-redeployed Worker)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ status: "error" });
    await expect(fetchTiingoEurUsd(PROXY, { fetchImpl })).rejects.toBeInstanceOf(PriceError);
  });

  it("is a no-op without a proxy URL", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return jsonResponse([]);
    };
    expect(await fetchTiingoEurUsd("", { fetchImpl })).toBeNull();
    expect(called).toBe(false);
  });
});

describe("fetchTiingoFxBars / EUR/USD on the unified Tiingo bar pipe", () => {
  it("requests fxHistory with the cadence + window and parses ascending EUR→USD bars", async () => {
    let calledUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      calledUrl = String(url);
      return jsonResponse([
        { date: "2026-06-23T00:00:00.000Z", ticker: "eurusd", close: 1.142905 },
        { date: "2026-06-19T00:00:00.000Z", ticker: "eurusd", close: 1.146945 },
      ]);
    };
    const bars = await fetchTiingoFxBars(PROXY, {
      fetchImpl,
      resampleFreq: "1day",
      startDate: "2026-06-19",
      endDate: "2026-06-23",
    });
    expect(calledUrl).toContain("fxHistory=eurusd");
    expect(calledUrl).toContain("resampleFreq=1day");
    expect(calledUrl).toContain("startDate=2026-06-19");
    expect(calledUrl).toContain("endDate=2026-06-23");
    // Sorted ascending by instant; value is the raw `close` (USD per 1 EUR).
    expect(bars.map((b) => b.t)).toEqual([
      Date.parse("2026-06-19T00:00:00.000Z"),
      Date.parse("2026-06-23T00:00:00.000Z"),
    ]);
    expect(bars[0].value.toString()).toBe("1.146945");
  });

  it("defaults the pair to eurusd and forwards an intraday cadence", async () => {
    let calledUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      calledUrl = String(url);
      return jsonResponse([]);
    };
    await fetchTiingoFxBars(PROXY, { fetchImpl, resampleFreq: "1hour" });
    expect(calledUrl).toContain("fxHistory=eurusd");
    expect(calledUrl).toContain("resampleFreq=1hour");
  });

  it("drops rows with a non-positive or unparseable close", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([
        { date: "2026-06-23T00:00:00.000Z", close: 0 },
        { date: "bad-date", close: 1.1 },
        { date: "2026-06-22T00:00:00.000Z", close: 1.14268 },
      ]);
    const bars = await fetchTiingoFxBars(PROXY, { fetchImpl });
    expect(bars).toHaveLength(1);
    expect(bars[0].value.toString()).toBe("1.14268");
  });

  it("returns [] for an empty window (no throw)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse([]);
    expect(await fetchTiingoFxBars(PROXY, { fetchImpl })).toEqual([]);
  });

  it("throws a retryable PriceError on a 429 (reserve spent)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse([], { ok: false, status: 429 });
    await expect(fetchTiingoFxBars(PROXY, { fetchImpl })).rejects.toBeInstanceOf(PriceError);
  });

  it("returns [] on a plain 4xx gap rather than throwing", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse([], { ok: false, status: 404 });
    expect(await fetchTiingoFxBars(PROXY, { fetchImpl })).toEqual([]);
  });

  it("throws when the proxy returns a non-array (un-redeployed Worker)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ status: "error" });
    await expect(fetchTiingoFxBars(PROXY, { fetchImpl })).rejects.toBeInstanceOf(PriceError);
  });

  it("is a no-op without a proxy URL", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return jsonResponse([]);
    };
    expect(await fetchTiingoFxBars("", { fetchImpl })).toEqual([]);
    expect(called).toBe(false);
  });

  it("routes the EUR/USD symbol through makeTiingoBarFetcher to the fxHistory route", async () => {
    let calledUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      calledUrl = String(url);
      return jsonResponse([{ date: "2026-06-23T00:00:00.000Z", close: 1.14 }]);
    };
    const fetcher = makeTiingoBarFetcher(PROXY, {
      param: "daily",
      startDate: "2026-06-19",
      endDate: "2026-06-23",
      fetchImpl,
    });
    const bars = await fetcher(["EUR/USD"]);
    // EUR/USD never hits the equity price route; it is served by fxHistory.
    expect(calledUrl).toContain("fxHistory=eurusd");
    expect(calledUrl).toContain("resampleFreq=1day");
    expect(calledUrl).not.toContain("daily=EUR");
    expect(bars.get("EUR/USD")![0].value.toString()).toBe("1.14");
  });
});
