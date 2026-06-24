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
import type { BarFetcher, IntradayAnchor } from "../src/intraday";
import {
  buildLiveSessionCurve,
  buildLiveWeekCurve,
  instrumentedGraphRecorders,
  makeCapacitySplitBarFetcher,
  makeDualFxFetcher,
  makePriceBarFetcher,
  makeWindowFxFetcher,
  recordingBarFetcher,
  recordingFxFetcher,
  sessionFxWindow,
  weekFxWindow,
  withFxBackoff,
  type BackfillMeter,
  type LiveGraphProviders,
  type SpendRequest,
} from "../src/live-graph";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";
import { PriceError, type FetchLike } from "../src/prices";
import type { Bar } from "../src/timeseries";

const d = (v: string | number): Decimal => new Decimal(v);

const PRICE_PROXY = "https://worker.example.dev/price";

/** One USD-booked ETF with a constant base — enough to drive both builders. */
function anchor(): IntradayAnchor {
  return {
    holdings: [
      { priceSymbol: "VTI", valueEur: d(900), valueUsd: d(1000), closeNative: d(100), isUsdNative: true, priceType: "market" },
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

/** A two-phase {@link BackfillMeter} that records every reserve/settle/refund. */
function recordingMeter(): {
  meter: BackfillMeter;
  events: Array<{ phase: "reserve" | "settle" | "refund"; req: SpendRequest & { bars?: number; reason?: string } }>;
  /** Net credits left on the ledger: reservations minus refunds (settle is a no-op debit). */
  net: () => number;
} {
  const events: Array<{ phase: "reserve" | "settle" | "refund"; req: SpendRequest & { bars?: number; reason?: string } }> = [];
  const meter: BackfillMeter = {
    reserve: (req) => events.push({ phase: "reserve", req }),
    settle: (req) => events.push({ phase: "settle", req }),
    refund: (req) => events.push({ phase: "refund", req }),
  };
  const net = (): number =>
    events.reduce(
      (acc, e) => acc + (e.phase === "reserve" ? e.req.n : e.phase === "refund" ? -e.req.n : 0),
      0,
    );
  return { meter, events, net };
}

/** A fetch stub that answers every request with a fixed HTTP status + body. */
function statusFetch(status: number, body: unknown = []): FetchLike {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    }) as unknown as Response;
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

  it("falls back to Twelve Data forex when there is no proxy but a key is held", async () => {
    const { calls, fetchImpl } = recordingFetch({ values: [{ datetime: "2026-06-23", close: "1.1" }] });
    const fetchFx = makeWindowFxFetcher(null, { startDate: "2026-06-19", endDate: "2026-06-23" }, "1day", fetchImpl, undefined, {
      apiKey: "KEY",
    });
    const bars = await fetchFx!();
    // The EUR/USD forex series is pulled browser-direct (no Worker fxHistory).
    expect(calls.some((u) => u.includes("symbol=EUR%2FUSD") || u.includes("symbol=EUR/USD"))).toBe(true);
    expect(bars[0].value.toString()).toBe("1.1");
  });
});

describe("FX dual pipe + backoff (item 4)", () => {
  const bar = (v: number): Bar => ({ t: 1, value: d(v) });

  it("makeDualFxFetcher falls back to Twelve Data on an empty Tiingo result", async () => {
    let fellBack = false;
    const fx = makeDualFxFetcher(
      async () => [],
      async () => {
        fellBack = true;
        return [bar(1.1)];
      },
    );
    expect(await fx()).toEqual([bar(1.1)]);
    expect(fellBack).toBe(true);
  });

  it("makeDualFxFetcher falls back when the Tiingo pipe throws a PriceError", async () => {
    const fx = makeDualFxFetcher(
      async () => {
        throw new PriceError("Tiingo FX history proxy returned HTTP 400");
      },
      async () => [bar(1.2)],
    );
    expect(await fx()).toEqual([bar(1.2)]);
  });

  it("makeDualFxFetcher keeps a non-empty Tiingo result (no fallback)", async () => {
    let fellBack = false;
    const fx = makeDualFxFetcher(
      async () => [bar(1.3)],
      async () => {
        fellBack = true;
        return [bar(9)];
      },
    );
    expect(await fx()).toEqual([bar(1.3)]);
    expect(fellBack).toBe(false);
  });

  it("withFxBackoff suppresses re-attempts after an empty result, then clears on success", async () => {
    let store: number | null = null;
    const memo = {
      read: () => store,
      write: (at: number) => {
        store = at;
      },
      clear: () => {
        store = null;
      },
    };
    let calls = 0;
    let result: Bar[] = [];
    let t = 1000;
    const fx = withFxBackoff(
      async () => {
        calls += 1;
        return result;
      },
      memo,
      { now: () => t, cooldownMs: 10_000 },
    );
    // First call returns empty → memoised.
    expect(await fx()).toEqual([]);
    expect(calls).toBe(1);
    expect(store).toBe(1000);
    // A rebuild inside the cooldown short-circuits to [] without touching `inner`.
    t = 5000;
    expect(await fx()).toEqual([]);
    expect(calls).toBe(1);
    // Past the cooldown it tries again; a non-empty pull clears the memo.
    t = 20_000;
    result = [bar(1.1)];
    expect(await fx()).toEqual([bar(1.1)]);
    expect(calls).toBe(2);
    expect(store).toBeNull();
  });

  it("withFxBackoff arms the cooldown on a throw and re-raises it once", async () => {
    let store: number | null = null;
    const memo = {
      read: () => store,
      write: (at: number) => {
        store = at;
      },
      clear: () => {
        store = null;
      },
    };
    let calls = 0;
    const fx = withFxBackoff(
      async () => {
        calls += 1;
        throw new PriceError("boom");
      },
      memo,
      { now: () => 1000, cooldownMs: 10_000 },
    );
    await expect(fx()).rejects.toThrow("boom");
    expect(store).toBe(1000);
    // Within the cooldown the next rebuild is suppressed (no second network hit).
    expect(await fx()).toEqual([]);
    expect(calls).toBe(1);
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

describe("makeCapacitySplitBarFetcher (provider split, item 8)", () => {
  const barOf = (v: number): Bar[] => [{ t: 1, value: d(v) }];
  /** A fetcher that answers each requested symbol with a one-bar series + records calls. */
  function fakeFetcher(label: string, calls: Array<{ who: string; symbols: string[] }>, opts: { fail?: boolean; empty?: Set<string> } = {}): BarFetcher {
    return async (symbols) => {
      calls.push({ who: label, symbols: [...symbols] });
      if (opts.fail) throw new PriceError(`${label} down`);
      const out = new Map<string, Bar[]>();
      for (const s of symbols) out.set(s, opts.empty?.has(s) ? [] : barOf(1));
      return out;
    };
  }

  it("fills Twelve Data up to its budget and routes the overflow to Tiingo", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls),
      fakeFetcher("TII", calls),
      () => ({ minute: 2, day: 100 }),
    );
    const bars = await fetch(["A", "B", "C", "D"]);
    expect(bars.size).toBe(4);
    const td = calls.find((c) => c.who === "TD");
    const tii = calls.find((c) => c.who === "TII");
    expect(td?.symbols).toEqual(["A", "B"]); // M = min(4, 2, 100) = 2
    expect(tii?.symbols).toEqual(["C", "D"]); // overflow
  });

  it("routes everything to Tiingo when Twelve Data has zero budget left", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls),
      fakeFetcher("TII", calls),
      () => ({ minute: 0, day: 100 }),
    );
    await fetch(["A", "B"]);
    expect(calls.find((c) => c.who === "TD")?.symbols ?? []).toEqual([]);
    expect(calls.find((c) => c.who === "TII")?.symbols).toEqual(["A", "B"]);
  });

  it("clamps the Twelve Data slice to the scarcer of the minute/day budgets", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls),
      fakeFetcher("TII", calls),
      () => ({ minute: 8, day: 1 }),
    );
    await fetch(["A", "B", "C"]);
    expect(calls.find((c) => c.who === "TD")?.symbols).toEqual(["A"]); // day budget caps at 1
    expect(calls.find((c) => c.who === "TII")?.symbols).toEqual(["B", "C"]);
  });

  it("spills a failed Twelve Data symbol to Tiingo underneath the split", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls, { fail: true }),
      fakeFetcher("TII", calls),
      () => ({ minute: 2, day: 100 }),
    );
    const bars = await fetch(["A", "B"]);
    // Twelve Data threw, so both assigned symbols spill to Tiingo and still resolve.
    expect(bars.get("A")?.length).toBe(1);
    expect(bars.get("B")?.length).toBe(1);
    const spill = calls.filter((c) => c.who === "TII").flatMap((c) => c.symbols);
    expect(spill).toContain("A");
    expect(spill).toContain("B");
  });

  it("spills an empty (billed-but-no-bars) Twelve Data symbol to Tiingo", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls, { empty: new Set(["A"]) }),
      fakeFetcher("TII", calls),
      () => ({ minute: 2, day: 100 }),
    );
    const bars = await fetch(["A", "B"]);
    expect(bars.get("A")?.length).toBe(1); // refilled from Tiingo
    const spill = calls.filter((c) => c.who === "TII").flatMap((c) => c.symbols);
    expect(spill).toEqual(["A"]);
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

describe("two-phase credit accounting (reserve up-front, settle on result)", () => {
  it("recordingBarFetcher reserves one credit per symbol up-front and settles on success", async () => {
    const inner = async (symbols: string[]) =>
      new Map<string, Bar[]>(symbols.map((s) => [s, [{ t: 1, value: d(1) }]]));
    const { meter, events, net } = recordingMeter();
    const fetcher = recordingBarFetcher(inner, meter);
    await fetcher(["AAPL", "MSFT", "AAPL", "  "]); // dedup + blank-drop ⇒ 2
    expect(events.map((e) => e.phase)).toEqual(["reserve", "settle"]);
    expect(events[0].req).toMatchObject({ n: 2, leg: "bars", symbols: ["AAPL", "MSFT"] });
    expect(net()).toBe(2);
  });

  it("recordingBarFetcher reserves before the network resolves (paces concurrent dispatches)", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const inner: BarFetcher = async (symbols) => {
      await gate;
      return new Map<string, Bar[]>(symbols.map((s) => [s, []]));
    };
    const { meter, events } = recordingMeter();
    const pending = recordingBarFetcher(inner, meter)(["AAPL"]);
    // The reservation is already on the books while the call is still in flight.
    expect(events.map((e) => e.phase)).toEqual(["reserve"]);
    release!();
    await pending;
    expect(events.map((e) => e.phase)).toEqual(["reserve", "settle"]);
  });

  it("recordingBarFetcher refunds the reservation when the pipe throws (not billed)", async () => {
    const inner = async (): Promise<Map<string, Bar[]>> => {
      throw new PriceError("429");
    };
    const { meter, events, net } = recordingMeter();
    await expect(recordingBarFetcher(inner, meter)(["AAPL"])).rejects.toThrow();
    expect(events.map((e) => e.phase)).toEqual(["reserve", "refund"]);
    expect(net()).toBe(0);
  });

  it("recordingFxFetcher settles a returned FX pull (reached the meter, even when empty)", async () => {
    const { meter, events, net } = recordingMeter();
    await recordingFxFetcher(async () => [], meter)();
    expect(events.map((e) => e.phase)).toEqual(["reserve", "settle"]);
    expect(events[0].req).toMatchObject({ n: 1, leg: "fx", symbols: ["eurusd"] });
    expect(net()).toBe(1);
  });

  it("recordingFxFetcher refunds a thrown FX pull (the Worker-400 phantom-charge fix)", async () => {
    const { meter, net } = recordingMeter();
    await expect(
      recordingFxFetcher(async () => {
        throw new PriceError("Tiingo FX history proxy returned HTTP 400");
      }, meter)(),
    ).rejects.toThrow();
    expect(net()).toBe(0);
  });

  it("books a Tiingo 200+[] and a 404 (reached the meter) but refunds Worker rejects", async () => {
    // A Tiingo-only price pipe (no Twelve Data fallback) so the per-status billing
    // outcome is visible directly on the meter.
    const cases: Array<[number, number]> = [
      [200, 1], // empty array — reached Tiingo, billed
      [404, 1], // ticker unknown to Tiingo — reached Tiingo, billed
      [400, 0], // Worker rejected bad params before forwarding — not billed
      [429, 0], // hourly reserve spent, never forwarded — not billed
      [502, 0], // upstream fetch failed — not billed
      [503, 0], // no token — not billed
    ];
    for (const [status, expected] of cases) {
      const { meter, net } = recordingMeter();
      const fetcher = makePriceBarFetcher({
        apiKey: "",
        proxyUrl: PRICE_PROXY,
        param: "intraday",
        fetchImpl: statusFetch(status),
        tiingoMeter: meter,
      })!;
      try {
        await fetcher(["VTI"]);
      } catch {
        // A pipe-level reject with no fallback configured propagates — expected.
      }
      expect(net(), `status ${status}`).toBe(expected);
    }
  });

  it("the 1D build books the Tiingo budget for both prices and FX", async () => {
    const { fetchImpl } = recordingFetch([{ date: "2026-06-23T13:35:00.000Z", close: 100 }]);
    const tiingo = recordingMeter();
    const twelve = recordingMeter();
    const store = new TimeSeriesStore(memoryBackend());
    const providers: LiveGraphProviders = {
      apiKey: "KEY",
      priceProxyUrl: PRICE_PROXY,
      fetchImpl,
      tiingoMeter: tiingo.meter,
      twelveDataMeter: twelve.meter,
    };
    await buildLiveSessionCurve(
      { anchor: anchor(), store, now: new Date("2026-06-23T14:00:00Z") },
      providers,
    );
    // One credit for the single price symbol + one for the batched FX pull.
    expect(tiingo.net()).toBe(2);
    expect(twelve.net()).toBe(0);
  });

  it("books the Twelve Data budget when prices fall back to Pipe A", async () => {
    // Tiingo prices answer empty (fallback to Twelve Data); FX still via Tiingo.
    const fetchImpl: FetchLike = async (url) => {
      const u = String(url);
      const body = u.includes("fxHistory")
        ? [{ date: "2026-06-23T00:00:00.000Z", close: 1.1 }]
        : u.includes("time_series")
          ? { values: [{ datetime: "2026-06-23 09:35:00", close: "100" }] }
          : [];
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    };
    const tiingo = recordingMeter();
    const twelve = recordingMeter();
    const store = new TimeSeriesStore(memoryBackend());
    const providers: LiveGraphProviders = {
      apiKey: "KEY",
      priceProxyUrl: PRICE_PROXY,
      fetchImpl,
      tiingoMeter: tiingo.meter,
      twelveDataMeter: twelve.meter,
    };
    await buildLiveSessionCurve(
      { anchor: anchor(), store, now: new Date("2026-06-23T14:00:00Z") },
      providers,
    );
    // Twelve Data served the price symbol (1 credit). Tiingo still booked its
    // billed price attempt (an empty answer is not a throw) plus the FX pull.
    expect(twelve.net()).toBe(1);
    expect(tiingo.net()).toBe(2);
  });
});

describe("instrumentedGraphRecorders", () => {
  it("books each pull, tallies credits, and logs the leg + symbols", () => {
    const twelveBooked: number[] = [];
    const tiingoBooked: number[] = [];
    const messages: string[] = [];
    const spent = { credits: 0 };
    const { twelveDataMeter, tiingoMeter } = instrumentedGraphRecorders({
      range: "1D",
      bookTwelveData: (n) => twelveBooked.push(n),
      refundTwelveData: () => undefined,
      bookTiingo: (n) => tiingoBooked.push(n),
      refundTiingo: () => undefined,
      log: (m) => messages.push(m),
      spent,
    });

    twelveDataMeter.reserve({ leg: "bars", symbols: ["SCHK", "MSFT", "VOO"], n: 3 });
    twelveDataMeter.settle({ leg: "bars", symbols: ["SCHK", "MSFT", "VOO"], n: 3, bars: 30 });
    tiingoMeter.reserve({ leg: "fx", symbols: ["eurusd"], n: 1 });
    tiingoMeter.settle({ leg: "fx", symbols: ["eurusd"], n: 1, bars: 5 });

    // Credits are booked against the matching provider budget on reserve…
    expect(twelveBooked).toEqual([3]);
    expect(tiingoBooked).toEqual([1]);
    // …the shared counter tallies only billed (settled) pulls…
    expect(spent.credits).toBe(4);
    // …and each billed pull names the leg + symbols (or `FX <pair>`).
    expect(messages).toEqual([
      "1D graph: fetched bars SCHK, MSFT, VOO via Twelve Data (Pipe A) — 3 credits.",
      "1D graph: fetched fx FX eurusd via Tiingo (Pipe B) — 1 Tiingo credit.",
    ]);
  });

  it("refunds and logs a labelled failure when a pull is not billed", () => {
    const tiingoBooked: number[] = [];
    const tiingoRefunded: number[] = [];
    const messages: string[] = [];
    const spent = { credits: 0 };
    const { tiingoMeter } = instrumentedGraphRecorders({
      range: "1D",
      bookTwelveData: () => undefined,
      refundTwelveData: () => undefined,
      bookTiingo: (n) => tiingoBooked.push(n),
      refundTiingo: (n) => tiingoRefunded.push(n),
      log: (m) => messages.push(m),
      spent,
    });

    tiingoMeter.reserve({ leg: "fx", symbols: ["eurusd"], n: 1 });
    tiingoMeter.refund({ leg: "fx", symbols: ["eurusd"], n: 1, reason: "Tiingo FX history proxy returned HTTP 400" });

    expect(tiingoBooked).toEqual([1]);
    expect(tiingoRefunded).toEqual([1]);
    // A refunded (not-billed) pull never counts toward the build's real spend.
    expect(spent.credits).toBe(0);
    expect(messages).toEqual([
      "1D graph: fx FX eurusd via Tiingo (Pipe B) not billed (1 Tiingo credit refunded) — Tiingo FX history proxy returned HTTP 400.",
    ]);
  });

  it("annotates a billed-but-empty pull (reached the provider, no bars)", () => {
    const messages: string[] = [];
    const spent = { credits: 0 };
    const { tiingoMeter } = instrumentedGraphRecorders({
      range: "1W",
      bookTwelveData: () => undefined,
      refundTwelveData: () => undefined,
      bookTiingo: () => undefined,
      refundTiingo: () => undefined,
      log: (m) => messages.push(m),
      spent,
    });
    tiingoMeter.reserve({ leg: "bars", symbols: ["DAX"], n: 1 });
    tiingoMeter.settle({ leg: "bars", symbols: ["DAX"], n: 1, bars: 0 });
    expect(spent.credits).toBe(1);
    expect(messages).toEqual([
      "1W graph: fetched bars DAX via Tiingo (Pipe B) — 1 Tiingo credit (empty — reached the provider, no bars).",
    ]);
  });

  it("leaves the credit counter at zero when nothing is pulled (all reused)", () => {
    const spent = { credits: 0 };
    instrumentedGraphRecorders({
      range: "1W",
      bookTwelveData: () => undefined,
      refundTwelveData: () => undefined,
      bookTiingo: () => undefined,
      refundTiingo: () => undefined,
      log: () => undefined,
      spent,
    });
    // Constructing the recorders must not, by itself, book or count anything.
    expect(spent.credits).toBe(0);
  });
});
