import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLiveEvent, LOST_AFTER_MS, resetServerFlow, shouldShowLost, startLive, UPDATED_SHOWN_MS } from "./live";
import { getServerStatus, resetServerStatus } from "./serverStatus";

const overview = (ccy: "EUR" | "USD") => ({
  ccy,
  fx_eur_usd: "1.0800",
  kpis: { total_value: ccy === "EUR" ? "1000.00" : "1080.00" },
  kpis_secondary: { total_value: ccy === "EUR" ? "1080.00" : "1000.00" },
  freshness: { last_price_update_at: "2026-11-03T10:00:00Z", prices_live: false, market_state: "open" },
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

describe("tick handling", () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // 2.5 s stagger
    qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function observe(key: unknown[], fn: () => unknown) {
    const obs = new QueryObserver(qc, { queryKey: key, queryFn: async () => fn() });
    return obs.subscribe(() => undefined);
  }

  it("patches the totals at once, then refetches active queries once after the stagger", async () => {
    const both = () => ({ EUR: overview("EUR"), USD: overview("USD") });
    qc.setQueryData(["overview", "both"], both());
    const eurFetch = vi.fn(both);
    const unsub = observe(["overview", "both"], eurFetch);

    const tick = {
      type: "tick",
      total_value_eur: "1100.00",
      total_value_usd: "1210.00",
      fx_eur_usd: "1.1000",
      last_update_at: "2026-11-03T10:01:00Z",
      prices_live: true,
    };
    handleLiveEvent(qc, JSON.stringify(tick));
    handleLiveEvent(qc, JSON.stringify(tick)); // a second tick inside the delay joins the first

    const cached = qc.getQueryData<Record<"EUR" | "USD", ReturnType<typeof overview>>>(["overview", "both"])!;
    const eur = cached.EUR;
    expect(eur.kpis.total_value).toBe("1100.00");
    expect(eur.kpis_secondary.total_value).toBe("1210.00");
    expect(eur.fx_eur_usd).toBe("1.1000");
    expect(eur.freshness).toMatchObject({ last_price_update_at: "2026-11-03T10:01:00Z", prices_live: true });
    const usd = cached.USD;
    expect(usd.kpis.total_value).toBe("1210.00");
    expect(usd.kpis_secondary.total_value).toBe("1100.00");

    await vi.advanceTimersByTimeAsync(2499);
    expect(eurFetch).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(eurFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(eurFetch).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("only marks inactive queries stale; they are not fetched", async () => {
    const fn = vi.fn(() => ({}));
    qc.setQueryDefaults(["holdings"], { queryFn: async () => fn() });
    qc.setQueryData(["holdings", "both", "none"], { rows: [] });
    qc.setQueryData(["analytics", "both", 365], 1);
    handleLiveEvent(qc, JSON.stringify({ type: "fx", fx_eur_usd: "1.09" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).not.toHaveBeenCalled();
    expect(qc.getQueryState(["holdings", "both", "none"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["analytics", "both", 365])?.isInvalidated).toBe(false);
  });

  it("appends the point to cached 1d graphs on both sides and updates holdings prices", () => {
    const graph = (ccy: "EUR" | "USD", sec: "EUR" | "USD") => ({
      ccy,
      points: [{ t: "2026-11-03T10:00:00Z", v: "1" }],
      secondary: { ccy: sec, points: [{ t: "2026-11-03T10:00:00Z", v: "2" }] },
    });
    qc.setQueryData(["graphs", "1d", "both"], { EUR: graph("EUR", "USD"), USD: graph("USD", "EUR") });
    qc.setQueryData(["graphs", "1m", "both"], { EUR: graph("EUR", "USD"), USD: graph("USD", "EUR") });
    const row = { instrument_id: 5, shares: "10", native_currency: "USD", price_native: "100", value: "1000" };
    qc.setQueryData(["holdings", "both", "none"], {
      EUR: { holdings: [row], fx_eur_usd: "2" },
      USD: { holdings: [row], fx_eur_usd: "2" },
    });
    const tick = {
      type: "tick",
      seq: 3,
      fx_eur_usd: "2",
      point: { t: "2026-11-03T10:01:00Z", EUR: "50", USD: "100" },
      prices: { "5": { px: "110", ccy: "USD", prev_close: "100", day_pct_usd: "0.1" } },
    };
    handleLiveEvent(qc, JSON.stringify(tick));
    handleLiveEvent(qc, JSON.stringify(tick)); // same t: replaced, not duplicated
    type G = Record<"EUR" | "USD", { points: { v: string }[]; secondary: { points: { v: string }[] } }>;
    const g = qc.getQueryData<G>(["graphs", "1d", "both"])!;
    expect(g.EUR.points.map((p) => p.v)).toEqual(["1", "50"]);
    expect(g.USD.points.map((p) => p.v)).toEqual(["1", "100"]);
    expect(g.EUR.secondary.points.map((p) => p.v)).toEqual(["2", "100"]);
    expect(qc.getQueryData<G>(["graphs", "1m", "both"])!.EUR.points).toHaveLength(1);
    type H = Record<"EUR" | "USD", { holdings: { value: string; price_native: string; today_pct: string }[] }>;
    const h = qc.getQueryData<H>(["holdings", "both", "none"])!;
    expect(h.USD.holdings[0]!.value).toBe("1100");
    expect(h.EUR.holdings[0]!.value).toBe("550");
    expect(h.USD.holdings[0]!.price_native).toBe("110");
    expect(Number(h.USD.holdings[0]!.today_pct)).toBeCloseTo(0.1);
  });
});

describe("server restarts", () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    qc = new QueryClient();
  });
  afterEach(() => {
    resetServerFlow();
    resetServerStatus();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("tracks planned and restarting announcements", () => {
    handleLiveEvent(qc, JSON.stringify({ type: "server", state: "restart_planned", at: "21:30" }));
    expect(getServerStatus()).toEqual({ kind: "planned", at: "21:30" });
    handleLiveEvent(qc, JSON.stringify({ type: "server", state: "restarting", version: "6.3.0", eta_s: 20 }));
    expect(getServerStatus()).toMatchObject({ kind: "restarting", version: "6.3.0", etaS: 20 });
  });

  it("polls health, then reconnects, shows 'updated' and clears it", async () => {
    const stop = startLive(qc);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ app_version: "6.2.0" }) })
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ok: true, json: async () => ({ app_version: "6.3.0" }) });
    vi.stubGlobal("fetch", fetchMock);

    handleLiveEvent(qc, JSON.stringify({ type: "server", state: "restarting", version: "6.3.0", eta_s: 20 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(getServerStatus().kind).toBe("restarting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(getServerStatus().kind).toBe("restarting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(getServerStatus()).toEqual({ kind: "updated", version: "6.3.0" });
    expect(FakeEventSource.instances).toHaveLength(2); // stream reopened
    await vi.advanceTimersByTimeAsync(UPDATED_SHOWN_MS);
    expect(getServerStatus().kind).toBe("idle");
    stop();
  });

  it("shows 'lost' only after a sustained stream drop", async () => {
    const stop = startLive(qc);
    FakeEventSource.instances[0]!.onopen?.();
    FakeEventSource.instances[0]!.onerror?.();
    await vi.advanceTimersByTimeAsync(1000); // reconnect attempt
    FakeEventSource.instances[1]!.onopen?.(); // brief blip: back before the delay
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS + 1000);
    expect(getServerStatus().kind).toBe("idle");

    FakeEventSource.instances[1]!.onerror?.();
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);
    expect(getServerStatus().kind).toBe("lost");
    await vi.advanceTimersByTimeAsync(2000);
    FakeEventSource.instances.at(-1)!.onopen?.();
    expect(getServerStatus().kind).toBe("idle");
    stop();
  });

  it("never shows 'lost' when the stream has not connected yet (login, 401 before the cookie)", async () => {
    const stop = startLive(qc);
    FakeEventSource.instances[0]!.onerror?.(); // first attempt fails
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS * 3);
    FakeEventSource.instances.at(-1)!.onerror?.();
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS * 3);
    expect(getServerStatus().kind).toBe("idle");
    stop();
  });
});

describe("shouldShowLost", () => {
  const base = { everConnected: true, liveStatus: "reconnecting" as const, serverKind: "idle", pathname: "/overview" };

  it("shows after a connected stream dropped and did not come back", () => {
    expect(shouldShowLost(base)).toBe(true);
  });
  it("waits for a first connection", () => {
    expect(shouldShowLost({ ...base, everConnected: false })).toBe(false);
  });
  it("stays quiet on the login and onboarding pages", () => {
    expect(shouldShowLost({ ...base, pathname: "/login" })).toBe(false);
    expect(shouldShowLost({ ...base, pathname: "/onboarding/step" })).toBe(false);
  });
  it("stays quiet when reconnected or a restart is announced", () => {
    expect(shouldShowLost({ ...base, liveStatus: "connected" })).toBe(false);
    expect(shouldShowLost({ ...base, serverKind: "restarting" })).toBe(false);
  });
  it("uses a grace period of about ten seconds", () => {
    expect(LOST_AFTER_MS).toBeGreaterThanOrEqual(10_000);
  });
});
