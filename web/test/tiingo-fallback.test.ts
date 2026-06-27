/**
 * Orchestration tests for `runTiingoFallback`: the wiring that runs after the
 * Twelve Data pass and decides whether to spend Tiingo calls on the gaps. These
 * exercise the I/O paths (budget reservation, quote merge, unified NAV/stock
 * eligibility) against an in-memory storage + a stubbed `/price` fetch; the pure
 * decision logic itself is covered by `tiingo-gate.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { Decimal } from "../src/decimal-config";
import { PriceError, type Quote } from "../src/prices";
import { latestSettledSessionDate } from "../src/market-hours";
import { runTiingoFallback, shouldQuickRefresh, planStartupRefresh, planPrefetch, tiingoBudgetView, tiingoLedgerView, msUntilNextHour } from "../src/tiingo-fallback";
import { WEB_DAILY_CAP, WEB_HOURLY_CAP } from "../src/tiingo-gate";
import { DEFAULT_PROVIDER_LIMITS, setProviderLimits, resetProviderLimits } from "../src/provider-limits";
import { tiingoCreditsSpentToday, readTiingoCreditLog, readTiingoNoNewer, recordTiingoCredits, type StorageLike } from "../src/cache";
import { recordTiingo429 } from "../src/provider-breaker";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const PROXY = "https://worker.example.dev/price";
const NOW = Date.UTC(2026, 5, 23, 18, 0, 0); // weekday afternoon ET
const EXPECTED = latestSettledSessionDate(new Date(NOW));

function emptyReport(deferred: string[] = []) {
  return { fetched: [], servedFresh: [], deferred, failed: [], error: null, minuteRemaining: 0, dayRemaining: 0, apiCalls: 0, creditsSpent: 0 };
}

/** A stub `/price` fetch returning the given IEX rows as JSON. */
function stubFetch(rows: Record<string, unknown>[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => rows,
  })) as unknown as typeof fetch;
}

function iexRow(ticker: string, last: number, timestamp: string): Record<string, unknown> {
  return { ticker, tngoLast: last, prevClose: last - 1, timestamp };
}

describe("runTiingoFallback", () => {
  it("is a no-op when no proxy URL is configured", async () => {
    const fetchImpl = vi.fn();
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: null,
      now: NOW,
      storage: memStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.budget).toEqual({ hourUsed: 0, hourLimit: 40, dayUsed: 0, dayLimit: 800 });
  });

  it("fills a deferred market symbol from Tiingo and reserves the budget", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([iexRow("AAPL", 200, `${EXPECTED}T20:00:00Z`)]);
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    expect(out.tiingoSymbols).toEqual(["AAPL"]);
    expect(out.quotes.get("AAPL")?.price?.toString()).toBe("200");
    expect(out.error).toBeNull();
    // Budget reserved up-front: one ticker spent today.
    expect(tiingoCreditsSpentToday(readTiingoCreditLog(NOW, undefined, storage), NOW)).toBe(1);
    expect(out.budget.dayUsed).toBe(1);
    // AAPL was merely *deferred* by the primary (an efficiency reroute that was
    // never attempted there), so it is not a genuine fallback.
    expect(out.fallbackSymbols).toEqual([]);
  });

  it("refunds the reserved credit when a Tiingo call 429s (no phantom over-count)", async () => {
    const storage = memStorage();
    // A 429 from the /price proxy: the call is rejected, delivering nothing.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    expect(out.error).toBeInstanceOf(PriceError);
    expect(out.error?.status).toBe(429);
    // The rejected call counts as one attempt but bills nothing: its reserved
    // credit is refunded so the hourly cap is not silently inflated (the user's
    // "calls left server-side, yet the app counted 40" over-count).
    expect(out.apiCalls).toBe(1);
    expect(out.creditsSpent).toBe(0);
    expect(tiingoCreditsSpentToday(readTiingoCreditLog(NOW, undefined, storage), NOW)).toBe(0);
    expect(out.budget.dayUsed).toBe(0);
  });

  it("holdBudgetReroute waits out the primary's budget deferrals but still backs up genuine failures", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([
      iexRow("AAPL", 200, `${EXPECTED}T20:00:00Z`),
      iexRow("MSFT", 300, `${EXPECTED}T20:00:00Z`),
    ]);
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL", "MSFT"],
      navSymbols: new Set(),
      quotes,
      // AAPL: budget-deferred (the primary is over its daily cap, never tried it).
      // MSFT: attempted on the primary and genuinely failed.
      report: { ...emptyReport(["AAPL"]), failed: ["MSFT"] },
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
      // The primary's daily cap resets imminently ⇒ hold its deferred book here.
      holdBudgetReroute: true,
    });
    // The budget-deferred AAPL is held back (wait for the primary's reset), while
    // the genuinely-failed MSFT is still rescued from the backup.
    expect(out.tiingoSymbols).toEqual(["MSFT"]);
    expect(out.quotes.has("AAPL")).toBe(false);
    expect(out.fallbackSymbols).toEqual(["MSFT"]);
    // Only one Tiingo credit spent (MSFT), not two — the backup wasn't drained.
    expect(out.budget.dayUsed).toBe(1);
  });

  it("holdBudgetReroute still spills the deferred book by default (no near reset)", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([iexRow("AAPL", 200, `${EXPECTED}T20:00:00Z`)]);
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
      holdBudgetReroute: false,
    });
    // Default behaviour is unchanged: the deferred symbol reroutes to Tiingo.
    expect(out.tiingoSymbols).toEqual(["AAPL"]);
  });

  it("flags a genuine fallback only for symbols the primary attempted and failed", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([
      iexRow("AAPL", 200, `${EXPECTED}T20:00:00Z`),
      iexRow("MSFT", 300, `${EXPECTED}T20:00:00Z`),
    ]);
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL", "MSFT"],
      navSymbols: new Set(),
      quotes,
      // AAPL: budget-deferred (never tried on primary) → efficiency reroute.
      // MSFT: attempted on primary and failed (unavailable/outdated) → genuine.
      report: { ...emptyReport(["AAPL"]), failed: ["MSFT"] },
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    expect(out.tiingoSymbols.sort()).toEqual(["AAPL", "MSFT"]);
    // Both were backup-filled, but only the primary-attempted-and-failed MSFT
    // counts as a genuine fallback the UI should flag.
    expect(out.fallbackSymbols).toEqual(["MSFT"]);
  });

  it("does not overwrite a fresher primary value with an older Tiingo bar", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([iexRow("AAPL", 150, "2020-01-02T20:00:00Z")]);
    const fresh: Quote = {
      symbol: "AAPL",
      price: new Decimal(199),
      previousClose: null,
      currency: "USD",
      at: NOW,
      priceTime: NOW,
      valueDate: EXPECTED,
      marketOpen: null,
    };
    const quotes = new Map<string, Quote>([["AAPL", fresh]]);
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(out.quotes.get("AAPL")?.price?.toString()).toBe("199");
  });

  it("fetches a behind NAV fund directly, exactly like a behind stock", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([iexRow("FSKAX", 100, `${EXPECTED}T21:00:00Z`)]);
    const peer: Quote = {
      symbol: "VTSAX",
      price: new Decimal(120),
      previousClose: null,
      currency: "USD",
      at: NOW - 31 * 60_000,
      priceTime: null,
      valueDate: EXPECTED,
      marketOpen: null,
    };
    const quotes = new Map<string, Quote>([["VTSAX", peer]]);
    const out = await runTiingoFallback({
      symbols: ["VTSAX", "FSKAX"],
      navSymbols: new Set(["VTSAX", "FSKAX"]),
      quotes,
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
    });
    // FSKAX is behind the latest settled session → eligible and fetched; VTSAX
    // already holds the target date → left untouched. No canary/peer timing.
    expect(out.tiingoSymbols).toEqual(["FSKAX"]);
    expect(out.quotes.get("FSKAX")?.valueDate).toBe(EXPECTED);
    // NAV fund: no faux intraday strike time.
    expect(out.quotes.get("FSKAX")?.priceTime).toBeNull();
  });

  it("fetches every behind NAV fund directly under forceAll, skipping recent ones", async () => {
    const storage = memStorage();
    const fetchImpl = stubFetch([
      iexRow("FSKAX", 100, `${EXPECTED}T21:00:00Z`),
      iexRow("VFIAX", 200, `${EXPECTED}T21:00:00Z`),
    ]);
    // VTSAX is already on the latest settled session (recent) → left untouched;
    // FSKAX and VFIAX are behind, and forceAll pulls them both at once.
    const recent: Quote = {
      symbol: "VTSAX",
      price: new Decimal(120),
      previousClose: null,
      currency: "USD",
      at: NOW,
      priceTime: null,
      valueDate: EXPECTED,
      marketOpen: null,
    };
    const quotes = new Map<string, Quote>([["VTSAX", recent]]);
    const out = await runTiingoFallback({
      symbols: ["VTSAX", "FSKAX", "VFIAX"],
      navSymbols: new Set(["VTSAX", "FSKAX", "VFIAX"]),
      quotes,
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
      forceAll: true,
    });
    expect(out.tiingoSymbols.sort()).toEqual(["FSKAX", "VFIAX"]);
    expect(out.quotes.get("FSKAX")?.valueDate).toBe(EXPECTED);
    expect(out.quotes.get("VFIAX")?.valueDate).toBe(EXPECTED);
    // The recent fund spent no Tiingo credit (only the two laggards did).
    expect(tiingoCreditsSpentToday(readTiingoCreditLog(NOW, undefined, storage), NOW)).toBe(2);
  });

  it("stops re-pulling a NAV fund the backup left no fresher (no-newer cooldown)", async () => {
    const storage = memStorage();
    // A mutual fund whose held NAV is days behind, and the backup only has the
    // same stale value-date (nothing newer exists yet — it's before the fund's
    // next publish). The first pass spends a credit; the second must accept the
    // stale value and not re-pull.
    const STALE = "2026-06-18"; // several sessions before EXPECTED
    const fetchImpl = stubFetch([iexRow("FSKAX", 100, `${STALE}T21:00:00Z`)]);
    const behind = (): Quote => ({
      symbol: "FSKAX",
      price: new Decimal(100),
      previousClose: null,
      currency: "USD",
      at: NOW,
      priceTime: null,
      valueDate: STALE,
      marketOpen: null,
    });
    // First pass: force the pull so it deterministically records a no-newer stamp.
    const first = await runTiingoFallback({
      symbols: ["FSKAX"],
      navSymbols: new Set(["FSKAX"]),
      quotes: new Map<string, Quote>([["FSKAX", behind()]]),
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
      forceAll: true,
    });
    expect(first.tiingoSymbols).toEqual(["FSKAX"]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Second pass (normal): the stamp suppresses the re-pull entirely.
    const second = await runTiingoFallback({
      symbols: ["FSKAX"],
      navSymbols: new Set(["FSKAX"]),
      quotes: new Map<string, Quote>([["FSKAX", behind()]]),
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW + 5 * 60_000,
      storage,
      fetchImpl,
    });
    expect(second.tiingoSymbols).toEqual([]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("forceAll bypasses the no-newer cooldown so the backup button always pulls", async () => {
    const storage = memStorage();
    const STALE = "2026-06-18";
    const fetchImpl = stubFetch([iexRow("FSKAX", 100, `${STALE}T21:00:00Z`)]);
    const behind = (): Quote => ({
      symbol: "FSKAX",
      price: new Decimal(100),
      previousClose: null,
      currency: "USD",
      at: NOW,
      priceTime: null,
      valueDate: STALE,
      marketOpen: null,
    });
    await runTiingoFallback({
      symbols: ["FSKAX"],
      navSymbols: new Set(["FSKAX"]),
      quotes: new Map<string, Quote>([["FSKAX", behind()]]),
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
      forceAll: true,
    });
    const again = await runTiingoFallback({
      symbols: ["FSKAX"],
      navSymbols: new Set(["FSKAX"]),
      quotes: new Map<string, Quote>([["FSKAX", behind()]]),
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW + 5 * 60_000,
      storage,
      fetchImpl,
      forceAll: true,
    });
    // The explicit "route everything through the backup" button ignores the stamp.
    expect(again.tiingoSymbols).toEqual(["FSKAX"]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("re-pulls once the backup advances the value-date (clears the stamp)", async () => {
    const storage = memStorage();
    const STALE = "2026-06-18";
    // First the backup is stale (records a stamp), then it advances to EXPECTED.
    const staleFetch = stubFetch([iexRow("FSKAX", 100, `${STALE}T21:00:00Z`)]);
    const behind = (): Quote => ({
      symbol: "FSKAX",
      price: new Decimal(100),
      previousClose: null,
      currency: "USD",
      at: NOW,
      priceTime: null,
      valueDate: STALE,
      marketOpen: null,
    });
    await runTiingoFallback({
      symbols: ["FSKAX"],
      navSymbols: new Set(["FSKAX"]),
      quotes: new Map<string, Quote>([["FSKAX", behind()]]),
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl: staleFetch,
      forceAll: true,
    });
    // A forced pass that advances the held NAV must clear the stamp.
    const freshFetch = stubFetch([iexRow("FSKAX", 101, `${EXPECTED}T21:00:00Z`)]);
    const advanced = await runTiingoFallback({
      symbols: ["FSKAX"],
      navSymbols: new Set(["FSKAX"]),
      quotes: new Map<string, Quote>([["FSKAX", behind()]]),
      report: emptyReport(),
      proxyUrl: PROXY,
      now: NOW + 5 * 60_000,
      storage,
      fetchImpl: freshFetch,
      forceAll: true,
    });
    expect(advanced.quotes.get("FSKAX")?.valueDate).toBe(EXPECTED);
    // The stamp is cleared, so the value-date now leads the eligibility checks.
    expect(readTiingoNoNewer(storage).FSKAX).toBeUndefined();
  });

  it("never throws on a transient fetch failure; reports it on .error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const quotes = new Map<string, Quote>();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes,
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage: memStorage(),
      fetchImpl,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(out.error).toBeInstanceOf(PriceError);
    expect(out.error?.retryable).toBe(true);
  });

  it("holds back reserveCredits so a run never spends the last few credits", async () => {
    const storage = memStorage();
    // Five deferred market symbols, but a reserve that leaves only two spendable
    // credits of the 40/hr cap (40 − 38). Only the first two are fetched.
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    const fetchImpl = stubFetch(symbols.map((s) => iexRow(s, 100, `${EXPECTED}T20:00:00Z`)));
    const out = await runTiingoFallback({
      symbols,
      navSymbols: new Set(),
      quotes: new Map<string, Quote>(),
      report: emptyReport(symbols),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl,
      reserveCredits: 38,
    });
    expect(out.tiingoSymbols).toEqual(["AAA", "BBB"]);
    expect(tiingoCreditsSpentToday(readTiingoCreditLog(NOW, undefined, storage), NOW)).toBe(2);
    // The reported budget still shows the true (unreserved) caps.
    expect(out.budget).toEqual({ hourUsed: 2, hourLimit: 40, dayUsed: 2, dayLimit: 800 });
  });

  it("lets an actual fallback (no reserve) spend the final credits the quick-start holds back", async () => {
    // Pre-spend 35 of the 40/hr cap so only the final 5 Tiingo credits remain.
    // The heavily-outdated startup quick-refresh reserves those 5 (fetches none);
    // a true gap-fill fallback — the default, reserveCredits 0 — may consume them.
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    const rows = symbols.map((s) => iexRow(s, 100, `${EXPECTED}T20:00:00Z`));

    const reserved = memStorage();
    recordTiingoCredits(35, NOW, reserved);
    const quickStart = await runTiingoFallback({
      symbols,
      navSymbols: new Set(),
      quotes: new Map<string, Quote>(),
      report: emptyReport(symbols),
      proxyUrl: PROXY,
      now: NOW,
      storage: reserved,
      fetchImpl: stubFetch(rows),
      reserveCredits: 5, // STARTUP_TIINGO_RESERVE — the "heavily outdated quick start".
    });
    expect(quickStart.tiingoSymbols).toEqual([]);

    const open = memStorage();
    recordTiingoCredits(35, NOW, open);
    const fallback = await runTiingoFallback({
      symbols,
      navSymbols: new Set(),
      quotes: new Map<string, Quote>(),
      report: emptyReport(symbols),
      proxyUrl: PROXY,
      now: NOW,
      storage: open,
      fetchImpl: stubFetch(rows),
      // reserveCredits omitted ⇒ 0: an actual fallback may spend the final 5.
    });
    expect(fallback.tiingoSymbols).toEqual(symbols);
    expect(tiingoCreditsSpentToday(readTiingoCreditLog(NOW, undefined, open), NOW)).toBe(40);
  });
});

describe("runTiingoFallback — budget enforcement via central readBudget", () => {
  it("surfaces error without fetching when Tiingo 429 breaker is frozen", async () => {
    const storage = memStorage();
    // Freeze Tiingo by recording a 429 — readBudget folds in the frozen state
    // and reports 0 remaining, so selectWithinBudget returns no symbols.
    recordTiingo429(NOW, storage);
    const fetchImpl = vi.fn();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes: new Map(),
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.error).not.toBeNull();
    expect(out.error!.message).toContain("budget exhausted");
    expect(out.error!.retryAfterMs).toBeGreaterThan(0);
  });

  it("surfaces error without fetching when Tiingo hourly budget is exhausted", async () => {
    const storage = memStorage();
    // Spend the entire hourly cap — readBudget reports 0 remaining.
    recordTiingoCredits(WEB_HOURLY_CAP, NOW, storage);
    const fetchImpl = vi.fn();
    const out = await runTiingoFallback({
      symbols: ["AAPL"],
      navSymbols: new Set(),
      quotes: new Map(),
      report: emptyReport(["AAPL"]),
      proxyUrl: PROXY,
      now: NOW,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.tiingoSymbols).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.error).not.toBeNull();
    expect(out.error!.message).toContain("budget exhausted");
    expect(out.error!.message).toContain("Central safety net");
    expect(out.error!.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("msUntilNextHour", () => {
  it("returns time until the next :00 boundary", () => {
    // 18:30:00 → 30 min until 19:00
    const at1830 = Date.UTC(2026, 5, 23, 18, 30, 0);
    expect(msUntilNextHour(at1830)).toBe(30 * 60 * 1000);
  });

  it("returns a full hour when exactly on :00", () => {
    const atHour = Date.UTC(2026, 5, 23, 18, 0, 0);
    expect(msUntilNextHour(atHour)).toBe(60 * 60 * 1000);
  });
});

describe("tiingoBudgetView", () => {
  it("reflects every Tiingo spend live from the credit log (graph pulls included)", () => {
    const storage = memStorage();
    // Simulate a 1D + 1W graph backfill spending Tiingo credits directly — no
    // quote fallback ran, so a snapshot taken there would miss these entirely.
    recordTiingoCredits(3, NOW, storage); // e.g. 1D bars
    recordTiingoCredits(2, NOW, storage); // e.g. 1W bars + FX
    const view = tiingoBudgetView(NOW, storage);
    expect(view.hourUsed).toBe(5);
    expect(view.dayUsed).toBe(5);
    expect(view.hourLimit).toBe(WEB_HOURLY_CAP);
    expect(view.dayLimit).toBe(WEB_DAILY_CAP);
  });

  it("starts at zero usage when nothing has been spent", () => {
    const view = tiingoBudgetView(NOW, memStorage());
    expect(view.hourUsed).toBe(0);
    expect(view.dayUsed).toBe(0);
  });
});

describe("tiingoLedgerView — the *true* local count, even while the 429 breaker is frozen", () => {
  it("reports the raw ledger counts unchanged by a freeze (budgetView reads the cap)", () => {
    const storage = memStorage();
    recordTiingoCredits(12, NOW, storage);
    // Freeze Tiingo: budgetView now reports the cap (40/40), but the ledger view
    // must still report what *this* device actually spent (12) — this is the
    // number that makes a "jumped to 40/40" line reconcilable in the log.
    recordTiingo429(NOW, storage);
    expect(tiingoBudgetView(NOW, storage).hourUsed).toBe(WEB_HOURLY_CAP);
    const ledger = tiingoLedgerView(NOW, storage);
    expect(ledger.hourUsed).toBe(12);
    expect(ledger.dayUsed).toBe(12);
  });

  it("matches the budget view when not frozen", () => {
    const storage = memStorage();
    recordTiingoCredits(5, NOW, storage);
    expect(tiingoLedgerView(NOW, storage)).toEqual({ hourUsed: 5, dayUsed: 5 });
  });
});

describe("planStartupRefresh", () => {
  it("leaves Tiingo untouched for a small outdated set (≤8)", () => {
    expect(planStartupRefresh({ outdatedCount: 8, tiingoRemaining: 40, tiingoAvailable: true })).toEqual({
      route: "twelve",
      tiingoBudget: 0,
    });
  });

  it("routes the whole book via Tiingo when the spare budget covers it", () => {
    // 12 outdated, 40 remaining, reserve 5 ⇒ usable 35 ≥ 12 ⇒ all Tiingo.
    expect(planStartupRefresh({ outdatedCount: 12, tiingoRemaining: 40, tiingoAvailable: true })).toEqual({
      route: "tiingo",
      tiingoBudget: 12,
    });
  });

  it("splits across Twelve + Tiingo when the set exceeds the spare budget", () => {
    // 20 outdated, 12 remaining, reserve 5 ⇒ usable 7 < 20 ⇒ split, Tiingo gets 7.
    expect(planStartupRefresh({ outdatedCount: 20, tiingoRemaining: 12, tiingoAvailable: true })).toEqual({
      route: "split",
      tiingoBudget: 7,
    });
  });

  it("wires everything to Twelve when no spare Tiingo budget remains", () => {
    // Only the reserve (or less) is left ⇒ a split is impossible ⇒ all Twelve.
    expect(planStartupRefresh({ outdatedCount: 20, tiingoRemaining: 5, tiingoAvailable: true })).toEqual({
      route: "twelve",
      tiingoBudget: 0,
    });
    expect(planStartupRefresh({ outdatedCount: 20, tiingoRemaining: 3, tiingoAvailable: true })).toEqual({
      route: "twelve",
      tiingoBudget: 0,
    });
  });

  it("wires everything to Twelve when Tiingo isn't configured", () => {
    expect(planStartupRefresh({ outdatedCount: 50, tiingoRemaining: 800, tiingoAvailable: false })).toEqual({
      route: "twelve",
      tiingoBudget: 0,
    });
  });

  it("tracks the Twelve Data per-minute limit for the 'leave Tiingo alone' threshold", () => {
    // Raising twelveDataPerMinute (a paid plan) means the primary clears a bigger
    // outdated set within a minute, so the Tiingo-skip threshold grows with it.
    setProviderLimits({ ...DEFAULT_PROVIDER_LIMITS, twelveDataPerMinute: 30 });
    try {
      // 20 outdated ≤ 30/min ⇒ the primary handles it, Tiingo stays untouched.
      expect(planStartupRefresh({ outdatedCount: 20, tiingoRemaining: 40, tiingoAvailable: true })).toEqual({
        route: "twelve",
        tiingoBudget: 0,
      });
      // 40 outdated > 30/min ⇒ worth spending Tiingo again (reserve 5 ⇒ usable 35).
      expect(planStartupRefresh({ outdatedCount: 40, tiingoRemaining: 40, tiingoAvailable: true })).toEqual({
        route: "split",
        tiingoBudget: 35,
      });
    } finally {
      resetProviderLimits();
    }
  });
});

describe("planPrefetch", () => {
  const base = {
    marketSymbols: ["AAA", "BBB"],
    outdatedMarketSymbols: ["AAA"],
    awaitingNavSymbols: ["FUND"],
    tiingoAvailable: true,
  };
  const empty = { navSymbols: [], graphSessionSymbols: [], graphWeekSymbols: [] };

  it("warms only the stocks/ETFs while the market is open", () => {
    expect(planPrefetch({ ...base, marketOpen: true })).toEqual({
      symbols: ["AAA", "BBB"],
      route: "twelve",
      ...empty,
    });
  });

  it("does not fall back to Tiingo for an open market, however many symbols", () => {
    const many = Array.from({ length: 20 }, (_, i) => `S${i}`);
    expect(planPrefetch({ ...base, marketOpen: true, marketSymbols: many })).toEqual({
      route: "twelve",
      symbols: many,
      ...empty,
    });
  });

  it("warms nothing while the market is closed and everything is in hand", () => {
    expect(
      planPrefetch({
        marketOpen: false,
        marketSymbols: ["AAA", "BBB"],
        outdatedMarketSymbols: [],
        awaitingNavSymbols: [],
        tiingoAvailable: true,
      }),
    ).toEqual({ symbols: [], route: "twelve", ...empty });
  });

  it("warms the outdated close on the primary and routes NAV funds to Twelve Data", () => {
    // The mutual fund is split out into navSymbols (always Twelve Data), never
    // lumped with the market quote — so a Tiingo route never burns a credit on it.
    expect(planPrefetch({ ...base, marketOpen: false })).toEqual({
      symbols: ["AAA"],
      route: "twelve",
      navSymbols: ["FUND"],
      graphSessionSymbols: [],
      graphWeekSymbols: [],
    });
  });

  it("rapid-fires a large (>8) closed-market catch-up through Tiingo, NAVs still on Twelve", () => {
    const outdated = Array.from({ length: 9 }, (_, i) => `S${i}`);
    expect(
      planPrefetch({
        marketOpen: false,
        marketSymbols: outdated,
        outdatedMarketSymbols: outdated,
        awaitingNavSymbols: ["FUND"],
        tiingoAvailable: true,
      }),
    ).toEqual({
      symbols: outdated,
      route: "tiingo",
      navSymbols: ["FUND"],
      graphSessionSymbols: [],
      graphWeekSymbols: [],
    });
  });

  it("keeps a small (≤8) closed-market catch-up on the Twelve Data primary", () => {
    const outdated = Array.from({ length: 8 }, (_, i) => `S${i}`);
    expect(
      planPrefetch({
        marketOpen: false,
        marketSymbols: outdated,
        outdatedMarketSymbols: outdated,
        awaitingNavSymbols: [],
        tiingoAvailable: true,
      }),
    ).toEqual({ symbols: outdated, route: "twelve", ...empty });
  });

  it("stays on the primary for a large catch-up when Tiingo isn't configured", () => {
    const outdated = Array.from({ length: 12 }, (_, i) => `S${i}`);
    expect(
      planPrefetch({
        marketOpen: false,
        marketSymbols: outdated,
        outdatedMarketSymbols: outdated,
        awaitingNavSymbols: [],
        tiingoAvailable: false,
      }),
    ).toEqual({ symbols: outdated, route: "twelve", ...empty });
  });

  it("pulls a stale 1D graph's bars and drops those symbols from the quote set (bars double as quotes)", () => {
    // AAA is outdated AND its 1D graph is stale → its Tiingo intraday bar covers
    // both, so it must NOT also appear in the quote `symbols` (no double-buy).
    const plan = planPrefetch({
      marketOpen: false,
      marketSymbols: ["AAA", "BBB"],
      outdatedMarketSymbols: ["AAA"],
      awaitingNavSymbols: [],
      tiingoAvailable: true,
      graphSessionStale: ["AAA", "BBB"],
    });
    expect(plan.graphSessionSymbols).toEqual(["AAA", "BBB"]);
    expect(plan.symbols).toEqual([]); // AAA covered by the bar pull
    expect(plan.route).toBe("twelve");
  });

  it("pulls a stale 1W graph's daily bars and dedupes them from the quote set too", () => {
    const plan = planPrefetch({
      marketOpen: false,
      marketSymbols: ["AAA", "BBB"],
      outdatedMarketSymbols: ["AAA", "BBB"],
      awaitingNavSymbols: [],
      tiingoAvailable: true,
      graphWeekStale: ["AAA"],
    });
    expect(plan.graphWeekSymbols).toEqual(["AAA"]);
    expect(plan.symbols).toEqual(["BBB"]); // BBB still needs a quote; AAA covered by bars
  });

  it("never pulls graph bars when Tiingo is unavailable (no proxy to reach them cheaply)", () => {
    const plan = planPrefetch({
      marketOpen: true,
      marketSymbols: ["AAA"],
      outdatedMarketSymbols: [],
      awaitingNavSymbols: [],
      tiingoAvailable: false,
      graphSessionStale: ["AAA"],
      graphWeekStale: ["AAA"],
    });
    expect(plan.graphSessionSymbols).toEqual([]);
    expect(plan.graphWeekSymbols).toEqual([]);
    expect(plan.symbols).toEqual(["AAA"]); // falls back to a plain Twelve Data quote
  });
});

describe("shouldQuickRefresh", () => {
  const HOUR = 60 * 60 * 1000;

  it("fires when the market is closed and we don't hold the latest close", () => {
    // Logged in the morning after close, last pull was yesterday's session (>1h),
    // and the latest settled close isn't in hand yet → fetch asap.
    expect(
      shouldQuickRefresh({
        now: NOW,
        marketOpen: false,
        lastQuickRefreshAt: null,
        freshestPriceAt: NOW - 12 * HOUR,
        holdsLatestClose: false,
      }),
    ).toBe(true);
  });

  it("fires even when the last pull was well under 24h ago (the old bug)", () => {
    expect(
      shouldQuickRefresh({
        now: NOW,
        marketOpen: false,
        lastQuickRefreshAt: null,
        freshestPriceAt: NOW - 3 * HOUR, // <24h but still missing the close
        holdsLatestClose: false,
      }),
    ).toBe(true);
  });

  it("stays quiet (market closed) once the latest close is already in hand", () => {
    expect(
      shouldQuickRefresh({
        now: NOW,
        marketOpen: false,
        lastQuickRefreshAt: null,
        freshestPriceAt: NOW - 12 * HOUR,
        holdsLatestClose: true,
      }),
    ).toBe(false);
  });

  it("suppresses a market-closed fire when we pulled within the last hour", () => {
    expect(
      shouldQuickRefresh({
        now: NOW,
        marketOpen: false,
        lastQuickRefreshAt: null,
        freshestPriceAt: NOW - 20 * 60 * 1000, // 20 min ago
        holdsLatestClose: false,
      }),
    ).toBe(false);
  });

  it("honours the once-per-hour quick-refresh throttle", () => {
    expect(
      shouldQuickRefresh({
        now: NOW,
        marketOpen: false,
        lastQuickRefreshAt: NOW - 10 * 60 * 1000, // quick-refreshed 10 min ago
        freshestPriceAt: NOW - 12 * HOUR,
        holdsLatestClose: false,
      }),
    ).toBe(false);
  });

  it("market open: fires only when >1h stale", () => {
    expect(
      shouldQuickRefresh({
        now: NOW,
        marketOpen: true,
        lastQuickRefreshAt: null,
        freshestPriceAt: NOW - 2 * HOUR,
        holdsLatestClose: true,
      }),
    ).toBe(true);
    expect(
      shouldQuickRefresh({
        now: NOW,
        marketOpen: true,
        lastQuickRefreshAt: null,
        freshestPriceAt: NOW - 10 * 60 * 1000,
        holdsLatestClose: true,
      }),
    ).toBe(false);
  });
});
