import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLiveStatus, resetLiveSeq, startLive, subscribeLiveEvents } from "./live";
import { getRefreshState, resetRefreshState } from "./refresh";

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
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

describe("startLive", () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    qc = new QueryClient();
    qc.setQueryData(["overview", "EUR"], 1);
    qc.setQueryData(["holdings", "EUR"], 1);
    qc.setQueryData(["periods", "EUR"], 1);
    qc.setQueryData(["auth", "me"], { authenticated: true });
  });
  afterEach(() => {
    resetLiveSeq();
    resetRefreshState();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const stale = (key: unknown[]) => qc.getQueryState(key)?.isInvalidated === true;

  it("invalidates live keys on tick and everything but auth on refresh", () => {
    const stop = startLive(qc);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/api/stream");
    es.onopen?.();
    es.emit({ type: "tick" });
    expect(stale(["overview", "EUR"])).toBe(true);
    expect(stale(["holdings", "EUR"])).toBe(true);
    expect(stale(["periods", "EUR"])).toBe(false);
    es.emit({ type: "refresh" });
    expect(stale(["periods", "EUR"])).toBe(true);
    expect(stale(["auth", "me"])).toBe(false);
    stop();
  });

  it("reconnects with backoff after an error", () => {
    const stop = startLive(qc);
    FakeEventSource.instances[0]!.onerror?.();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.onerror?.();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);
    stop();
    expect(FakeEventSource.instances[2]!.closed).toBe(true);
  });

  it("tracks refresh_started/progress/finished and refetches reports on finish", () => {
    const stop = startLive(qc);
    const es = FakeEventSource.instances[0]!;
    es.onopen?.();
    es.emit({ type: "refresh_started", source: "manual" });
    expect(getRefreshState()).toMatchObject({ running: true, source: "manual" });
    es.emit({ type: "refresh_progress", historical: true, progress_done: 2, progress_total: 5, progress_label: "Prices" });
    expect(getRefreshState()).toMatchObject({ running: true, historical: true, done: 2, total: 5, label: "Prices" });
    expect(stale(["periods", "EUR"])).toBe(false);
    es.emit({ type: "refresh_finished", source: "manual", updated: true, last_update_at: "2026-11-02T15:00:00Z" });
    expect(getRefreshState()).toMatchObject({ running: false, lastUpdateAt: "2026-11-02T15:00:00Z" });
    expect(stale(["periods", "EUR"])).toBe(true);
    expect(stale(["auth", "me"])).toBe(false);
    stop();
  });

  it("invalidates only the reloaded graph range and notifies listeners", () => {
    qc.setQueryData(["graphs", "1d", "EUR"], 1);
    qc.setQueryData(["graphs", "1w", "EUR"], 1);
    const seen: unknown[] = [];
    const off = subscribeLiveEvents((ev) => seen.push(ev.type));
    const stop = startLive(qc);
    FakeEventSource.instances[0]!.emit({ type: "graphs", range: "1d", ok: true, points: 12 });
    expect(stale(["graphs", "1d", "EUR"])).toBe(true);
    expect(stale(["graphs", "1w", "EUR"])).toBe(false);
    expect(seen).toEqual(["graphs"]);
    off();
    stop();
  });

  it("catches up from /api/live?since=<last seq> when the stream reopens, without marking stale", async () => {
    qc.setQueryData(["graphs", "1d", "both"], {
      EUR: { points: [{ t: "10:00", v: "1" }], secondary: null },
      USD: { points: [{ t: "10:00", v: "2" }], secondary: null },
    });
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ seq: 9, missed_points: [{ t: "10:05", EUR: "5", USD: "6" }], tick: null }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stop = startLive(qc);
    FakeEventSource.instances[0]!.onopen?.();
    FakeEventSource.instances[0]!.emit({ type: "tick", seq: 7 });
    qc.setQueryData(["overview", "EUR"], 1); // reset the stale mark the tick left
    FakeEventSource.instances[0]!.onerror?.();
    vi.advanceTimersByTime(1000);
    FakeEventSource.instances[1]!.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/live?since=7");
    const g = qc.getQueryData<{ EUR: { points: unknown[] } }>(["graphs", "1d", "both"])!;
    expect(g.EUR.points).toHaveLength(2);
    expect(stale(["overview", "EUR"])).toBe(false);
    stop();
  });

  it("refetches live keys when the stream reopens after a drop and there is no seq to catch up from", async () => {
    const stop = startLive(qc);
    expect(getLiveStatus()).toBe("connecting");
    FakeEventSource.instances[0]!.onopen?.();
    expect(stale(["overview", "EUR"])).toBe(false); // first open: data is fresh
    FakeEventSource.instances[0]!.onerror?.();
    expect(getLiveStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    FakeEventSource.instances[1]!.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(getLiveStatus()).toBe("connected");
    expect(stale(["overview", "EUR"])).toBe(true);
    stop();
  });
});
