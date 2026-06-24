/**
 * Tests for the Pipe-B Tiingo price backfill (`intraday-tiingo.ts`): the
 * per-symbol unified `/price` Worker client (`?intraday=`/`?daily=`), the bar
 * parser, and the dual-pipe fallback that degrades to the Twelve Data fetcher. A
 * stub fetch returns canned Tiingo payloads.
 */
import { describe, expect, it } from "vitest";

import {
  barsFromTiingoDaily,
  barsFromTiingoIntraday,
  fetchTiingoIntradayBars,
  makeTiingoBarFetcher,
  makeDualPipeBarFetcher,
} from "../src/intraday-tiingo";
import { PriceError, type FetchLike } from "../src/prices";
import { Decimal } from "../src/decimal-config";
import type { Bar } from "../src/timeseries";

const PROXY = "https://worker.example.dev/price";

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; retryAfter?: string } = {},
): Response {
  const headers = new Map<string, string>();
  if (init.retryAfter) headers.set("Retry-After", init.retryAfter);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (k: string) => headers.get(k) ?? null },
    json: async () => body,
  } as unknown as Response;
}

describe("barsFromTiingoIntraday", () => {
  it("maps close rows into ascending bars and drops unusable ones", () => {
    const bars = barsFromTiingoIntraday([
      { date: "2026-06-22T15:00:00.000Z", close: 102 },
      { date: "2026-06-22T14:00:00.000Z", close: 101 },
      { date: "not-a-date", close: 99 },
      { date: "2026-06-22T13:00:00.000Z", close: "bad" },
    ]);
    expect(bars.map((b) => b.value.toString())).toEqual(["101", "102"]);
    expect(bars[0].t).toBeLessThan(bars[1].t);
  });

  it("returns an empty array for a non-array body", () => {
    expect(barsFromTiingoIntraday({ detail: "Error" })).toEqual([]);
  });
});

describe("barsFromTiingoDaily", () => {
  it("emits an open and a close bar per day at the session bounds", () => {
    const bars = barsFromTiingoDaily([
      { date: "2026-06-22T00:00:00.000Z", open: 100, close: 102 },
    ]);
    // Two points: open (09:30 ET) then close (16:00 ET), ascending.
    expect(bars).toHaveLength(2);
    expect(bars[0].value.toString()).toBe("100");
    expect(bars[1].value.toString()).toBe("102");
    expect(bars[0].t).toBeLessThan(bars[1].t);
  });

  it("orders multiple days and keeps the price a row does have", () => {
    const bars = barsFromTiingoDaily([
      { date: "2026-06-23", open: 103, close: 105 },
      { date: "2026-06-22", close: 102 }, // no open ⇒ only a close bar
    ]);
    // Day 22 (close only) then day 23 (open + close): 3 bars, ascending.
    expect(bars.map((b) => b.value.toString())).toEqual(["102", "103", "105"]);
    for (let i = 1; i < bars.length; i += 1) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);
  });

  it("drops rows without a usable day and non-array bodies", () => {
    expect(barsFromTiingoDaily([{ open: 1, close: 2 }])).toEqual([]);
    expect(barsFromTiingoDaily({ detail: "Error" })).toEqual([]);
  });
});

describe("fetchTiingoIntradayBars", () => {
  it("requests the proxy once per ticker with the session window params", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(String(url));
      return jsonResponse([{ date: "2026-06-22T14:00:00.000Z", close: 100 }]);
    };
    const bars = await fetchTiingoIntradayBars(["AAPL", "MSFT"], PROXY, {
      fetchImpl,
      startDate: "2026-06-22",
      endDate: "2026-06-22",
    });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("intraday=AAPL");
    expect(urls[0]).toContain("startDate=2026-06-22");
    expect(bars.get("AAPL")?.[0].value.toString()).toBe("100");
    expect(bars.get("MSFT")?.[0].value.toString()).toBe("100");
  });

  it("uses the daily param when requested (1W curve)", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(String(url));
      return jsonResponse([{ date: "2026-06-22T00:00:00.000Z", close: 100 }]);
    };
    await fetchTiingoIntradayBars(["VOO"], PROXY, {
      fetchImpl,
      param: "daily",
      startDate: "2026-06-15",
      endDate: "2026-06-22",
    });
    expect(urls[0]).toContain("daily=VOO");
    expect(urls[0]).not.toContain("intraday=");
  });

  it("de-duplicates and skips blank symbols", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse([]);
    };
    await fetchTiingoIntradayBars(["AAPL", "AAPL", "  "], PROXY, { fetchImpl });
    expect(calls).toBe(1);
  });

  it("treats a 404 ticker as an empty gap, not a failure", async () => {
    const fetchImpl: FetchLike = async (url) =>
      String(url).includes("intraday=NOPE")
        ? jsonResponse({ detail: "Not found" }, { ok: false, status: 404 })
        : jsonResponse([{ date: "2026-06-22T14:00:00.000Z", close: 50 }]);
    const bars = await fetchTiingoIntradayBars(["NOPE", "AAPL"], PROXY, { fetchImpl });
    expect(bars.get("NOPE")).toEqual([]);
    expect(bars.get("AAPL")?.[0].value.toString()).toBe("50");
  });

  it("throws a retryable PriceError with Retry-After on a 429 reserve exhaustion", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ status: "error" }, { ok: false, status: 429, retryAfter: "30" });
    await expect(fetchTiingoIntradayBars(["AAPL"], PROXY, { fetchImpl })).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 30000,
    });
  });

  it("throws when the token is unconfigured (503)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ status: "error" }, { ok: false, status: 503 });
    await expect(fetchTiingoIntradayBars(["AAPL"], PROXY, { fetchImpl })).rejects.toBeInstanceOf(
      PriceError,
    );
  });

  it("throws when the proxy returns a non-array 200 (not relaying Tiingo)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ not: "an array" });
    await expect(fetchTiingoIntradayBars(["AAPL"], PROXY, { fetchImpl })).rejects.toBeInstanceOf(
      PriceError,
    );
  });

  it("throws a retryable error when the proxy is unreachable", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(fetchTiingoIntradayBars(["AAPL"], PROXY, { fetchImpl })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("returns empty without a proxy URL", async () => {
    const bars = await fetchTiingoIntradayBars(["AAPL"], "", {});
    expect(bars.size).toBe(0);
  });
});

describe("makeDualPipeBarFetcher", () => {
  const oneBar = (sym: string): Map<string, Bar[]> =>
    new Map([[sym, [{ t: 1, value: new Decimal(1) }]]]);

  it("uses Pipe B when it returns bars and never touches the fallback", async () => {
    let fellBack = false;
    const fetcher = makeDualPipeBarFetcher(
      async () => oneBar("AAPL"),
      async () => {
        fellBack = true;
        return oneBar("AAPL");
      },
    );
    const bars = await fetcher(["AAPL"]);
    expect(bars.get("AAPL")?.[0].value.toString()).toBe("1");
    expect(fellBack).toBe(false);
  });

  it("falls back to Pipe A on a Pipe-B PriceError", async () => {
    const fetcher = makeDualPipeBarFetcher(
      async () => {
        throw new PriceError("reserve spent", { status: 429, retryable: true });
      },
      async () => oneBar("AAPL"),
    );
    const bars = await fetcher(["AAPL"]);
    expect(bars.get("AAPL")?.[0].value.toString()).toBe("1");
  });

  it("falls back when Pipe B is reachable but returns no bars", async () => {
    const fetcher = makeDualPipeBarFetcher(
      async () => new Map<string, Bar[]>([["AAPL", []]]),
      async () => oneBar("AAPL"),
    );
    const bars = await fetcher(["AAPL"]);
    expect(bars.get("AAPL")?.[0].value.toString()).toBe("1");
  });

  it("trusts an empty Pipe-B result when fallbackOnEmpty is off", async () => {
    let fellBack = false;
    const fetcher = makeDualPipeBarFetcher(
      async () => new Map<string, Bar[]>([["AAPL", []]]),
      async () => {
        fellBack = true;
        return oneBar("AAPL");
      },
      { fallbackOnEmpty: false },
    );
    await fetcher(["AAPL"]);
    expect(fellBack).toBe(false);
  });

  it("re-throws a non-PriceError from Pipe B", async () => {
    const fetcher = makeDualPipeBarFetcher(
      async () => {
        throw new TypeError("boom");
      },
      async () => oneBar("AAPL"),
    );
    await expect(fetcher(["AAPL"])).rejects.toBeInstanceOf(TypeError);
  });

  it("short-circuits to an empty map for no symbols", async () => {
    let primaryCalled = false;
    const fetcher = makeDualPipeBarFetcher(
      async () => {
        primaryCalled = true;
        return oneBar("AAPL");
      },
      async () => oneBar("AAPL"),
    );
    const bars = await fetcher([]);
    expect(bars.size).toBe(0);
    expect(primaryCalled).toBe(false);
  });
});

describe("makeTiingoBarFetcher", () => {
  it("binds the proxy URL and options into a BarFetcher", async () => {
    let calledUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      calledUrl = String(url);
      return jsonResponse([{ date: "2026-06-22T14:00:00.000Z", close: 7 }]);
    };
    const fetcher = makeTiingoBarFetcher(PROXY, { fetchImpl, param: "intraday" });
    const bars = await fetcher(["AAPL"]);
    expect(calledUrl).toContain("intraday=AAPL");
    expect(bars.get("AAPL")?.[0].value.toString()).toBe("7");
  });
});
