import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLive } from "./live";

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
});
