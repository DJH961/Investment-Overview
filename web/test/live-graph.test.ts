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
  makeFxFetcher,
  makePriceBarFetcher,
  recordingBarFetcher,
  sessionFxWindow,
  weekFxWindow,
  withBarBackoff,
  cacheSeriesBackoff,
  type BackfillMeter,
  type LiveGraphProviders,
  type SpendRequest,
} from "../src/live-graph";
import { memoryBackend, TimeSeriesStore } from "../src/timeseries-store";
import { PriceError, type FetchLike } from "../src/prices";
import type { Bar } from "../src/timeseries";
import { ledgerReservation, type Provider, type Reservation } from "../src/reservation";
import { recordTwelveData429, recordTiingo429 } from "../src/provider-breaker";

const d = (v: string | number): Decimal => new Decimal(v);

/**
 * A fake {@link Reservation} over two integer credit pools (Twelve Data, Tiingo).
 * Each `reserve` grants `min(requested, remaining)` and debits the pool; `release`
 * returns credits. Records every grant so a test can assert the split's routing.
 * A pool of `0` models a fully-spent budget or a frozen provider.
 */
function fakeReservation(
  tdAvail: number,
  tiiAvail: number,
): { reservation: Reservation; grants: Array<{ provider: Provider; requested: number; granted: number }> } {
  let td = tdAvail;
  let tii = tiiAvail;
  const grants: Array<{ provider: Provider; requested: number; granted: number }> = [];
  const reservation: Reservation = {
    reserve(provider, requested) {
      const pool = provider === "twelvedata" ? td : tii;
      const granted = Math.max(0, Math.min(requested, pool));
      if (provider === "twelvedata") td -= granted;
      else tii -= granted;
      grants.push({ provider, requested, granted });
      return granted;
    },
    release(provider, n) {
      if (provider === "twelvedata") td += n;
      else tii += n;
    },
  };
  return { reservation, grants };
}

/** A minimal in-memory `StorageLike` for backoff persistence tests. */
function mapStorage(): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
} {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

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

  it("the 1D window widens back a session to recover the prior close (item 5b)", () => {
    // Sun 2026-06-28: last session is Fri 26th, prior session Thu 25th.
    const now = new Date("2026-06-28T20:00:00Z");
    expect(sessionFxWindow(now)).toEqual({ startDate: "2026-06-26", endDate: "2026-06-26" });
    expect(sessionFxWindow(now, 2)).toEqual({ startDate: "2026-06-25", endDate: "2026-06-26" });
    // sessionsBack <= 1 always collapses to the single current session.
    expect(sessionFxWindow(now, 1)).toEqual({ startDate: "2026-06-26", endDate: "2026-06-26" });
  });
});

describe("makeFxFetcher (EUR/USD rides the unified price pipe)", () => {
  it("is null when no pipe is configured", () => {
    expect(makeFxFetcher(null)).toBeNull();
    // A price fetcher with neither key nor proxy is null → FX is null too.
    expect(makeFxFetcher(makePriceBarFetcher({ apiKey: "", proxyUrl: null }))).toBeNull();
  });

  it("routes EUR/USD to Tiingo's fxHistory route (1day cadence) on a Tiingo-only pipe", async () => {
    const { calls, fetchImpl } = recordingFetch([{ date: "2026-06-23T00:00:00.000Z", close: 1.14 }]);
    const fetchFx = makeFxFetcher(
      makePriceBarFetcher({
        apiKey: "", // Tiingo-only
        proxyUrl: PRICE_PROXY,
        param: "daily",
        startDate: "2026-06-19",
        endDate: "2026-06-23",
        fetchImpl,
      }),
    );
    const bars = await fetchFx!();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("fxHistory=eurusd");
    expect(calls[0]).toContain("resampleFreq=1day");
    expect(calls[0]).toContain("startDate=2026-06-19");
    expect(calls[0]).toContain("endDate=2026-06-23");
    expect(bars[0].value.toString()).toBe("1.14");
  });

  it("routes EUR/USD to fxHistory at a 1hour cadence for the intraday (1D) pipe", async () => {
    const { calls, fetchImpl } = recordingFetch([{ date: "2026-06-23T13:00:00.000Z", close: 1.1 }]);
    const fetchFx = makeFxFetcher(
      makePriceBarFetcher({
        apiKey: "",
        proxyUrl: PRICE_PROXY,
        param: "intraday",
        startDate: "2026-06-23",
        endDate: "2026-06-23",
        fetchImpl,
      }),
    );
    await fetchFx!();
    expect(calls[0]).toContain("fxHistory=eurusd");
    expect(calls[0]).toContain("resampleFreq=1hour");
  });

  it("pulls EUR/USD browser-direct from Twelve Data when there is no proxy but a key is held", async () => {
    const { calls, fetchImpl } = recordingFetch({ values: [{ datetime: "2026-06-23", close: "1.1" }] });
    const fetchFx = makeFxFetcher(
      makePriceBarFetcher({ apiKey: "KEY", proxyUrl: null, param: "daily", fetchImpl }),
    );
    const bars = await fetchFx!();
    expect(calls.some((u) => u.includes("symbol=EUR%2FUSD") || u.includes("symbol=EUR/USD"))).toBe(true);
    expect(bars[0].value.toString()).toBe("1.1");
  });
});

describe("makeFxFetcher — Twelve-Data-first via the shared capacity split", () => {
  it("serves EUR/USD from Twelve Data first when it has budget (no Tiingo fxHistory)", async () => {
    const { calls, fetchImpl } = recordingFetch({ values: [{ datetime: "2026-06-23", close: "1.1" }] });
    // Twelve Data has room, Tiingo budget 0 (frozen).
    const fetchFx = makeFxFetcher(
      makePriceBarFetcher({
        apiKey: "KEY",
        proxyUrl: PRICE_PROXY,
        param: "daily",
        startDate: "2026-06-19",
        endDate: "2026-06-23",
        fetchImpl,
        reservation: fakeReservation(8, 0).reservation,
      }),
    );
    const bars = await fetchFx!();
    // Twelve Data forex served it; no Tiingo fxHistory pull was attempted.
    expect(calls.some((u) => u.includes("fxHistory"))).toBe(false);
    expect(calls.some((u) => u.includes("symbol=EUR%2FUSD") || u.includes("symbol=EUR/USD"))).toBe(true);
    expect(bars[0].value.toString()).toBe("1.1");
  });

  it("spills EUR/USD to Tiingo's fxHistory route when the Twelve Data budget is spent", async () => {
    const { calls, fetchImpl } = recordingFetch([{ date: "2026-06-23T00:00:00.000Z", close: 1.12 }]);
    const fetchFx = makeFxFetcher(
      makePriceBarFetcher({
        apiKey: "KEY",
        proxyUrl: PRICE_PROXY,
        param: "daily",
        startDate: "2026-06-19",
        endDate: "2026-06-23",
        fetchImpl,
        reservation: fakeReservation(0, 8).reservation,
      }),
    );
    const bars = await fetchFx!();
    // No Twelve Data forex pull (budget 0); Tiingo fxHistory served the track.
    expect(calls.some((u) => u.includes("symbol=EUR%2FUSD") || u.includes("symbol=EUR/USD"))).toBe(false);
    expect(calls.some((u) => u.includes("fxHistory"))).toBe(true);
    expect(bars[0].value.toString()).toBe("1.12");
  });

  it("fires nothing when both budgets are exhausted (degrades to baseFx)", async () => {
    const { calls, fetchImpl } = recordingFetch([]);
    const fetchFx = makeFxFetcher(
      makePriceBarFetcher({
        apiKey: "KEY",
        proxyUrl: PRICE_PROXY,
        param: "daily",
        startDate: "2026-06-19",
        endDate: "2026-06-23",
        fetchImpl,
        reservation: fakeReservation(0, 0).reservation,
      }),
    );
    expect(await fetchFx!()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("withBarBackoff (per-symbol time-series backoff)", () => {
  it("drops a symbol from the network only after 3 empty/failed pulls, sparing the quote", async () => {
    const memory = mapStorage();
    const backoff = cacheSeriesBackoff({ attempts: 3, cooldownMs: 10_000, storage: memory });
    const seen: string[][] = [];
    let t = 1000;
    // AAPL always comes back empty; MSFT always returns bars.
    const inner: BarFetcher = async (symbols) => {
      seen.push(symbols);
      const out = new Map<string, Bar[]>();
      for (const s of symbols) if (s === "MSFT") out.set(s, [{ t: 1, value: d(1) }]);
      return out;
    };
    const fetch = withBarBackoff(inner, backoff, (s) => `1W:${s}`, { now: () => t });
    // Three rounds: AAPL is attempted each time (still trying), MSFT keeps clearing.
    await fetch(["AAPL", "MSFT"]);
    await fetch(["AAPL", "MSFT"]);
    await fetch(["AAPL", "MSFT"]);
    expect(seen).toEqual([
      ["AAPL", "MSFT"],
      ["AAPL", "MSFT"],
      ["AAPL", "MSFT"],
    ]);
    // 4th round: AAPL is now suppressed (parked), only MSFT reaches the network.
    seen.length = 0;
    const out = await fetch(["AAPL", "MSFT"]);
    expect(seen).toEqual([["MSFT"]]);
    expect(out.has("AAPL")).toBe(false); // absent ⇒ curve holds AAPL flat at its quote
    expect(out.get("MSFT")?.length).toBe(1);
    // Past the cooldown AAPL is retried again.
    t = 20_000;
    seen.length = 0;
    await fetch(["AAPL", "MSFT"]);
    expect(seen).toEqual([["AAPL", "MSFT"]]);
  });

  it("returns an empty map (no network) when every symbol is suppressed", async () => {
    const memory = mapStorage();
    const backoff = cacheSeriesBackoff({ attempts: 1, cooldownMs: 10_000, storage: memory });
    let calls = 0;
    const inner: BarFetcher = async () => {
      calls += 1;
      return new Map<string, Bar[]>();
    };
    const fetch = withBarBackoff(inner, backoff, (s) => `1D:${s}`, { now: () => 1000 });
    await fetch(["AAPL"]); // first attempt fails ⇒ arms (attempts: 1)
    expect(calls).toBe(1);
    const out = await fetch(["AAPL"]); // suppressed
    expect(calls).toBe(1);
    expect(out.size).toBe(0);
  });

  it("keeps 1D and 1W scopes independent (a 1D error never suppresses 1W)", async () => {
    const memory = mapStorage();
    const backoff = cacheSeriesBackoff({ attempts: 1, cooldownMs: 10_000, storage: memory });
    const inner = (label: string): BarFetcher => async (symbols) => {
      // The 1D leg always fails for AAPL; the 1W leg always serves it.
      const out = new Map<string, Bar[]>();
      if (label === "1W") for (const s of symbols) out.set(s, [{ t: 1, value: d(1) }]);
      return out;
    };
    const day = withBarBackoff(inner("1D"), backoff, (s) => `1D:${s}`, { now: () => 1000 });
    const week = withBarBackoff(inner("1W"), backoff, (s) => `1W:${s}`, { now: () => 1000 });
    await day(["AAPL"]); // arms 1D:AAPL
    expect(backoff.suppressed("1D:AAPL", 1000)).toBe(true);
    expect(backoff.suppressed("1W:AAPL", 1000)).toBe(false); // 1W untouched
    const out = await week(["AAPL"]); // still fetched on the 1W scope
    expect(out.get("AAPL")?.length).toBe(1);
  });

  it("retroactively recovers a symbol: the bars flow again once it succeeds after the cooldown", async () => {
    const memory = mapStorage();
    const backoff = cacheSeriesBackoff({ attempts: 1, cooldownMs: 10_000, storage: memory });
    let alive = false;
    let t = 1000;
    const inner: BarFetcher = async (symbols) => {
      const out = new Map<string, Bar[]>();
      if (alive) for (const s of symbols) out.set(s, [{ t: 2, value: d(2) }]);
      return out;
    };
    const fetch = withBarBackoff(inner, backoff, (s) => `1W:${s}`, { now: () => t });
    await fetch(["AAPL"]); // fails ⇒ armed; curve holds AAPL flat at its quote meanwhile
    expect(backoff.suppressed("1W:AAPL", t)).toBe(true);
    // The endpoint recovers; once the cooldown elapses the retry succeeds and the
    // memo clears, so the corrected bars flow back into the curve.
    alive = true;
    t = 20_000;
    const out = await fetch(["AAPL"]);
    expect(out.get("AAPL")?.length).toBe(1);
    expect(backoff.suppressed("1W:AAPL", t)).toBe(false);
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
      fakeReservation(2, 100).reservation,
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
      fakeReservation(0, 100).reservation,
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
      fakeReservation(1, 100).reservation,
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
      fakeReservation(2, 100).reservation,
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
      fakeReservation(2, 100).reservation,
    );
    const bars = await fetch(["A", "B"]);
    expect(bars.get("A")?.length).toBe(1); // refilled from Tiingo
    const spill = calls.filter((c) => c.who === "TII").flatMap((c) => c.symbols);
    expect(spill).toEqual(["A"]);
  });

  it("defers the overflow instead of dumping it on a frozen Tiingo (WS4/WS5)", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls),
      fakeFetcher("TII", calls),
      fakeReservation(2, 0).reservation, // Tiingo frozen ⇒ 0 grant
    );
    const bars = await fetch(["A", "B", "C", "D"]);
    // Twelve Data still serves up to its budget; the overflow is held back for a
    // later round rather than wasted on a provider that has already said no.
    expect(calls.find((c) => c.who === "TD")?.symbols).toEqual(["A", "B"]);
    expect(calls.find((c) => c.who === "TII")?.symbols ?? []).toEqual([]);
    expect(bars.get("A")?.length).toBe(1);
    expect(bars.get("C")).toBeUndefined();
  });

  it("does not spill Twelve Data misses to a frozen Tiingo", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls, { empty: new Set(["A"]) }),
      fakeFetcher("TII", calls),
      fakeReservation(8, 0).reservation, // Tiingo frozen ⇒ 0 grant
    );
    const bars = await fetch(["A", "B"]);
    expect(calls.find((c) => c.who === "TII")).toBeUndefined();
    expect(bars.get("A")?.length ?? 0).toBe(0); // empty miss left for a later round
    expect(bars.get("B")?.length).toBe(1);
  });

  it("caps the Tiingo overflow at Tiingo's own budget and defers the rest (Flags 1, 5)", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    // Twelve Data can take 2, Tiingo only 1 — so of the 4 symbols, A,B go to TD,
    // C goes to Tiingo, and D is deferred (neither provider can pay for it now).
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls),
      fakeFetcher("TII", calls),
      fakeReservation(2, 1).reservation,
    );
    const bars = await fetch(["A", "B", "C", "D"]);
    expect(calls.find((c) => c.who === "TD")?.symbols).toEqual(["A", "B"]);
    expect(calls.find((c) => c.who === "TII")?.symbols).toEqual(["C"]);
    expect(bars.get("C")?.length).toBe(1);
    expect(bars.get("D")).toBeUndefined(); // over both caps ⇒ deferred, not dumped
  });

  it("is atomic across concurrent builds: two splits over one ledger never overshoot", async () => {
    const calls: Array<{ who: string; symbols: string[] }> = [];
    // The *real* authority over a shared in-memory ledger (8 Twelve Data credits).
    const store = mapStorage();
    const reservation = ledgerReservation(store);
    const td = fakeFetcher("TD", calls);
    // Tiingo absorbs the overflow (and fails), but the point is that both builds
    // read-and-debit the same ledger, so their *combined* Twelve Data dispatch
    // must not exceed the 8-credit minute, with the rest spilling/deferring.
    const split = makeCapacitySplitBarFetcher(td, fakeFetcher("TII", calls, { fail: true }), reservation);
    await Promise.all([
      split(["A", "B", "C", "D", "E"]),
      split(["F", "G", "H", "I", "J"]),
    ]);
    const tdSymbols = calls.filter((c) => c.who === "TD").flatMap((c) => c.symbols);
    expect(tdSymbols.length).toBe(8); // exactly the per-minute budget, never 10
  });

  it("regression: a hard refresh during a 429 freeze issues ZERO provider calls", async () => {
    // The user's scenario: both providers are inside a 429 freeze and the user
    // mashes refresh. A hard refresh may clear soft TTL/backoff, but the breaker
    // is authoritative — the single reservation authority grants 0 to *both*
    // providers, so not one leg fetcher fires and we burn no credits.
    const store = mapStorage();
    const now = 1_000_000;
    recordTwelveData429(now, store);
    recordTiingo429(now, store);
    const calls: Array<{ who: string; symbols: string[] }> = [];
    const fetch = makeCapacitySplitBarFetcher(
      fakeFetcher("TD", calls),
      fakeFetcher("TII", calls),
      ledgerReservation(store),
      () => now,
    );
    const bars = await fetch(["A", "B", "C"]);
    expect(calls).toHaveLength(0); // no network leg attempted at all
    expect(bars.size).toBe(0); // nothing fetched ⇒ curve falls back to cache
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

  it("recordingBarFetcher calls inner with the trimmed+deduped symbol set", async () => {
    const seen: string[][] = [];
    const inner: BarFetcher = async (symbols) => {
      seen.push(symbols);
      return new Map<string, Bar[]>(symbols.map((s) => [s, [{ t: 1, value: d(1) }]]));
    };
    const { meter } = recordingMeter();
    await recordingBarFetcher(inner, meter)(["AAPL", "MSFT", "AAPL", "  "]);
    expect(seen).toEqual([["AAPL", "MSFT"]]);
  });

  it("recordingBarFetcher short-circuits (no inner call, no metering) when no real symbols remain", async () => {
    let calls = 0;
    const inner: BarFetcher = async () => {
      calls += 1;
      return new Map<string, Bar[]>();
    };
    const { meter, events } = recordingMeter();
    const bars = await recordingBarFetcher(inner, meter)(["  ", ""]);
    expect(calls).toBe(0);
    expect(bars.size).toBe(0);
    expect(events).toEqual([]);
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
    tiingoMeter.reserve({ leg: "bars", symbols: ["EUR/USD"], n: 1 });
    tiingoMeter.settle({ leg: "bars", symbols: ["EUR/USD"], n: 1, bars: 5 });

    // Credits are booked against the matching provider budget on reserve…
    expect(twelveBooked).toEqual([3]);
    expect(tiingoBooked).toEqual([1]);
    // …the shared counter tallies only billed (settled) pulls…
    expect(spent.credits).toBe(4);
    // …and each billed pull names the leg + symbols (FX rides the bars leg).
    expect(messages).toEqual([
      "1D graph: fetched bars SCHK, MSFT, VOO via Twelve Data (Pipe A) — 3 credits.",
      "1D graph: fetched bars EUR/USD via Tiingo (Pipe B) — 1 Tiingo credit.",
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

    tiingoMeter.reserve({ leg: "bars", symbols: ["EUR/USD"], n: 1 });
    tiingoMeter.refund({ leg: "bars", symbols: ["EUR/USD"], n: 1, reason: "Tiingo FX history proxy returned HTTP 400" });

    expect(tiingoBooked).toEqual([1]);
    expect(tiingoRefunded).toEqual([1]);
    // A refunded (not-billed) pull never counts toward the build's real spend.
    expect(spent.credits).toBe(0);
    expect(messages).toEqual([
      "1D graph: bars EUR/USD via Tiingo (Pipe B) not billed (1 Tiingo credit refunded) — Tiingo FX history proxy returned HTTP 400.",
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
