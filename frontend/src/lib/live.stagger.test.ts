import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLiveEvent, LOST_AFTER_MS, resetServerFlow, startLive, UPDATED_SHOWN_MS } from "./live";
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
    qc.setQueryData(["overview", "EUR"], overview("EUR"));
    qc.setQueryData(["overview", "USD"], overview("USD"));
    const eurFetch = vi.fn(() => overview("EUR"));
    const unsub = observe(["overview", "EUR"], eurFetch);

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

    const eur = qc.getQueryData<ReturnType<typeof overview>>(["overview", "EUR"])!;
    expect(eur.kpis.total_value).toBe("1100.00");
    expect(eur.kpis_secondary.total_value).toBe("1210.00");
    expect(eur.fx_eur_usd).toBe("1.1000");
    expect(eur.freshness).toMatchObject({ last_price_update_at: "2026-11-03T10:01:00Z", prices_live: true });
    const usd = qc.getQueryData<ReturnType<typeof overview>>(["overview", "USD"])!;
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
    qc.setQueryData(["holdings", "EUR", "none"], { rows: [] });
    qc.setQueryData(["periods", "EUR"], 1);
    handleLiveEvent(qc, JSON.stringify({ type: "fx", fx_eur_usd: "1.09" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).not.toHaveBeenCalled();
    expect(qc.getQueryState(["holdings", "EUR", "none"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["periods", "EUR"])?.isInvalidated).toBe(false);
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
});
