/**
 * Tests for the live-graph orchestration (`live-graph.ts`) — that the 1D/1W
 * builders are wired to the dual-pipe price backfill AND the batched Tiingo
 * FX-history backfill over the curve's exact date window. The injected fetch
 * records the URLs each pipe hits, so we assert the FX track is pulled in one
 * batched request at the right cadence, and that pipes drop out cleanly when a
 * key/proxy is absent. No DOM / IndexedDB / live API is touched.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { IntradayAnchor } from "../src/intraday";
import {
  buildLiveSessionCurve,
  buildLiveWeekCurve,
  makePriceBarFetcher,
  makeWindowFxFetcher,
  recordingBarFetcher,
  recordingFxFetcher,
  sessionFxWindow,
  weekFxWindow,
  type LiveGraphProviders,
} from "../src/live-graph";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";
import type { FetchLike } from "../src/prices";
import type { Bar } from "../src/timeseries";

const d = (v: string | number): Decimal => new Decimal(v);

const PRICE_PROXY = "https://worker.example.dev/price";

/** One USD-booked ETF with a constant base — enough to drive both builders. */
function anchor(): IntradayAnchor {
  return {
    holdings: [
      { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true },
    ],
    baseEur: d(100),
    baseUsd: d(100),
    baseFx: d("0.9"),
  };
}

/** A fetch stub that records every URL and answers with a canned JSON array. */
function recordingFetch(body: unknown = []): { calls: string[]; fetchImpl: FetchLike } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  };
  return { calls, fetchImpl };
}

describe("FX windows", () => {
  it("the 1D window is the single current session day", () => {
    // Tue 2026-06-23 14:00 UTC == 10:00 ET, a regular session.
    expect(sessionFxWindow(new Date("2026-06-23T14:00:00Z"))).toEqual({
      startDate: "2026-06-23",
      endDate: "2026-06-23",
    });
  });

  it("the 1W window spans the trailing trading sessions, oldest→newest", () => {
    const w = weekFxWindow(new Date("2026-06-23T14:00:00Z"), 5);
    expect(w.endDate).toBe("2026-06-23");
    // Five trading sessions back from Tue 23rd reaches into the prior week.
    expect(Date.parse(w.startDate)).toBeLessThan(Date.parse(w.endDate));
  });
});

describe("makeWindowFxFetcher", () => {
  it("pulls the FX track in one batched fxHistory request over the window", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { date: "2026-06-23T00:00:00.000Z", close: 1.14 },
    ]);
    const fetchFx = makeWindowFxFetcher(
      PRICE_PROXY,
      { startDate: "2026-06-19", endDate: "2026-06-23" },
      "1day",
      fetchImpl,
    );
    const bars = await fetchFx!();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("fxHistory=eurusd");
    expect(calls[0]).toContain("resampleFreq=1day");
    expect(calls[0]).toContain("startDate=2026-06-19");
    expect(calls[0]).toContain("endDate=2026-06-23");
    expect(bars[0].value.toString()).toBe("1.14");
  });

  it("is null (baseFx-only FX) when no price proxy is configured", () => {
    expect(makeWindowFxFetcher(null, { startDate: "a", endDate: "b" }, "1day")).toBeNull();
  });
});

describe("makePriceBarFetcher", () => {
  it("returns null when neither a key nor a price proxy is configured", () => {
    expect(makePriceBarFetcher({ apiKey: "", proxyUrl: null })).toBeNull();
  });

  it("uses Tiingo (Pipe B) and falls back to Twelve Data (Pipe A) on an empty B", async () => {
    // Pipe B (Tiingo) returns an empty array → dual-pipe falls back to Pipe A.
    const { calls, fetchImpl } = recordingFetch([]);
    const fetch = makePriceBarFetcher({
      apiKey: "KEY",
      proxyUrl: PRICE_PROXY,
      param: "intraday",
      fetchImpl,
    })!;
    await fetch(["VTI"]);
    // First hits the Tiingo intraday proxy, then the Twelve Data time_series.
    expect(calls[0]).toContain("/price?intraday=VTI");
    expect(calls.some((u) => u.includes("time_series"))).toBe(true);
  });

  it("requests Tiingo daily closes when param=daily (the 1W price pipe)", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { date: "2026-06-23T00:00:00.000Z", close: 100 },
    ]);
    const fetch = makePriceBarFetcher({
      apiKey: "KEY",
      proxyUrl: PRICE_PROXY,
      param: "daily",
      startDate: "2026-06-17",
      endDate: "2026-06-23",
      fetchImpl,
    })!;
    await fetch(["VTI"]);
    // Tiingo daily returns bars → no fallback to Twelve Data is needed.
    expect(calls[0]).toContain("/price?daily=VTI");
    expect(calls.some((u) => u.includes("time_series"))).toBe(false);
  });
});

describe("buildLiveSessionCurve", () => {
  it("wires both backfills: Tiingo intraday prices + a 1hour FX track for the day", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { date: "2026-06-23T13:35:00.000Z", close: 100 },
    ]);
    const store = new TimeSeriesStore(memoryBackend());
    const providers: LiveGraphProviders = {
      apiKey: "KEY",
      priceProxyUrl: PRICE_PROXY,
      fetchImpl,
    };
    const now = new Date("2026-06-23T14:00:00Z");
    const curve = await buildLiveSessionCurve(
      { anchor: anchor(), store, now, liveTip: { valueEur: d(1010), valueUsd: d(1110) } },
      providers,
    );
    expect(curve.day).toBe("2026-06-23");
    expect(curve.points.length).toBeGreaterThan(0);
    // The session prices were pulled from the Tiingo intraday pipe.
    expect(calls.some((u) => u.includes("intraday=VTI"))).toBe(true);
    // The FX track was pulled for the session day at an intraday cadence.
    const fxCall = calls.find((u) => u.includes("fxHistory=eurusd"));
    expect(fxCall).toBeDefined();
    expect(fxCall).toContain("resampleFreq=1hour");
    expect(fxCall).toContain("startDate=2026-06-23");
    expect(fxCall).toContain("endDate=2026-06-23");
  });

  it("still builds (baseFx FX, Twelve Data prices) with no Worker proxies", async () => {
    const { calls, fetchImpl } = recordingFetch([{ datetime: "2026-06-23 09:35:00", close: "100" }]);
    const store = new TimeSeriesStore(memoryBackend());
    const curve = await buildLiveSessionCurve(
      { anchor: anchor(), store, now: new Date("2026-06-23T14:00:00Z") },
      { apiKey: "KEY", priceProxyUrl: null, fetchImpl },
    );
    expect(curve.day).toBe("2026-06-23");
    // No FX history was requested (no proxy); prices came from Twelve Data.
    expect(calls.some((u) => u.includes("fxHistory"))).toBe(false);
    expect(calls.some((u) => u.includes("time_series"))).toBe(true);
  });
});

describe("buildLiveWeekCurve", () => {
  it("wires Tiingo daily prices + a daily FX track over the trailing-session window", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { date: "2026-06-23T00:00:00.000Z", close: 100 },
    ]);
    const store = new TimeSeriesStore(memoryBackend());
    const providers: LiveGraphProviders = {
      apiKey: "KEY",
      priceProxyUrl: PRICE_PROXY,
      fetchImpl,
    };
    const now = new Date("2026-06-23T14:00:00Z");
    await buildLiveWeekCurve({ anchor: anchor(), store, now, sessions: 5 }, providers);
    // The daily closes were pulled from the Tiingo daily pipe (not Twelve Data).
    const dailyCall = calls.find((u) => u.includes("daily=VTI"));
    expect(dailyCall).toBeDefined();
    expect(dailyCall).toContain("startDate=");
    expect(calls.some((u) => u.includes("time_series"))).toBe(false);
    const fxCall = calls.find((u) => u.includes("fxHistory=eurusd"));
    expect(fxCall).toBeDefined();
    expect(fxCall).toContain("resampleFreq=1day");
    expect(fxCall).toContain("endDate=2026-06-23");
  });

  it("falls back to Twelve Data daily closes when Tiingo returns nothing", async () => {
    // The Tiingo daily pipe answers empty for the price symbol, so the dual pipe
    // degrades to Twelve Data's interval=1day; the FX track still comes from Tiingo.
    const fxBody = [{ date: "2026-06-23T00:00:00.000Z", close: 1.1 }];
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = String(url);
      calls.push(u);
      const body = u.includes("fxHistory")
        ? fxBody
        : u.includes("time_series")
          ? { values: [{ datetime: "2026-06-23", close: "100" }] }
          : [];
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    };
    const store = new TimeSeriesStore(memoryBackend());
    const providers: LiveGraphProviders = { apiKey: "KEY", priceProxyUrl: PRICE_PROXY, fetchImpl };
    await buildLiveWeekCurve(
      { anchor: anchor(), store, now: new Date("2026-06-23T14:00:00Z"), sessions: 5 },
      providers,
    );
    expect(calls.some((u) => u.includes("daily=VTI"))).toBe(true);
    expect(calls.some((u) => u.includes("time_series"))).toBe(true);
  });
});

describe("credit accounting (live-graph backfills count against a source budget)", () => {
  it("recordingBarFetcher books one credit per requested symbol on success", async () => {
    const spends: number[] = [];
    const inner = async (symbols: string[]) =>
      new Map<string, Bar[]>(symbols.map((s) => [s, [{ t: 1, value: d(1) }]]));
    const fetcher = recordingBarFetcher(inner, (n) => spends.push(n));
    await fetcher(["AAPL", "MSFT", "AAPL", "  "]); // dedup + blank-drop ⇒ 2
    expect(spends).toEqual([2]);
  });

  it("recordingBarFetcher books nothing when the inner pipe throws", async () => {
    const spends: number[] = [];
    const inner = async (): Promise<Map<string, Bar[]>> => {
      throw new Error("429");
    };
    const fetcher = recordingBarFetcher(inner, (n) => spends.push(n));
    await expect(fetcher(["AAPL"])).rejects.toThrow();
    expect(spends).toEqual([]);
  });

  it("recordingFxFetcher books one credit per successful FX pull", async () => {
    const spends: number[] = [];
    const fetcher = recordingFxFetcher(async () => [], (n) => spends.push(n));
    await fetcher();
    expect(spends).toEqual([1]);
  });

  it("the 1D build books the Tiingo budget for both prices and FX", async () => {
    const { fetchImpl } = recordingFetch([{ date: "2026-06-23T13:35:00.000Z", close: 100 }]);
    const tiingo: number[] = [];
    const twelve: number[] = [];
    const store = new TimeSeriesStore(memoryBackend());
    const providers: LiveGraphProviders = {
      apiKey: "KEY",
      priceProxyUrl: PRICE_PROXY,
      fetchImpl,
      onTiingoSpend: (n) => tiingo.push(n),
      onTwelveDataSpend: (n) => twelve.push(n),
    };
    await buildLiveSessionCurve(
      { anchor: anchor(), store, now: new Date("2026-06-23T14:00:00Z") },
      providers,
    );
    // One credit for the single price symbol + one for the batched FX pull.
    expect(tiingo).toEqual([1, 1]);
    expect(twelve).toEqual([]);
  });

  it("books the Twelve Data budget when prices fall back to Pipe A", async () => {
    // Tiingo prices answer empty (fallback to Twelve Data); FX still via Tiingo.
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = String(url);
      calls.push(u);
      const body = u.includes("fxHistory")
        ? [{ date: "2026-06-23T00:00:00.000Z", close: 1.1 }]
        : u.includes("time_series")
          ? { values: [{ datetime: "2026-06-23 09:35:00", close: "100" }] }
          : [];
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    };
    const tiingo: number[] = [];
    const twelve: number[] = [];
    const store = new TimeSeriesStore(memoryBackend());
    const providers: LiveGraphProviders = {
      apiKey: "KEY",
      priceProxyUrl: PRICE_PROXY,
      fetchImpl,
      onTiingoSpend: (n) => tiingo.push(n),
      onTwelveDataSpend: (n) => twelve.push(n),
    };
    await buildLiveSessionCurve(
      { anchor: anchor(), store, now: new Date("2026-06-23T14:00:00Z") },
      providers,
    );
    // Twelve Data served the price symbol (1 credit). Tiingo still spent a
    // credit on the price attempt (an empty answer is not a throw) plus the FX.
    expect(twelve).toEqual([1]);
    expect(tiingo).toEqual([1, 1]);
  });
});
