/**
 * Tests for the Tiingo IEX client (`tiingo.ts`) that talks to the `/price`
 * Worker proxy. A stub fetch returns canned IEX payloads.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { fetchTiingoQuotes } from "../src/tiingo";
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

  it("falls back to prevClose when no last price is present", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([{ ticker: "VOO", prevClose: 500.0, timestamp: "2026-06-22T15:59:00-04:00" }]);
    const quotes = await fetchTiingoQuotes(["VOO"], PROXY, { fetchImpl });
    expect(quotes.get("VOO")?.price).toEqual(new Decimal(500));
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
