import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  AUTO_REFETCH_WAIT_MS,
  applyRefreshEvent,
  deriveUpdateMode,
  getRefreshState,
  resetRefreshState,
  setRefreshState,
  takeDeferredAutoRefetch,
} from "./refresh";
import { getReadActivity, resetReadActivity, trackRead } from "./updateActivity";
import { QueryClient } from "@tanstack/react-query";

const idle = { running: false, explicit: false, historical: false };
const none = { background: 0, foreground: 0 };

afterEach(() => {
  resetRefreshState();
  resetReadActivity();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("deriveUpdateMode", () => {
  it("nothing in flight is idle", () => {
    expect(deriveUpdateMode(idle)).toBe("idle");
  });

  it("a scheduled server refresh is quiet, an explicit one is loud", () => {
    expect(deriveUpdateMode({ running: true, explicit: false, historical: false })).toBe("quiet");
    expect(deriveUpdateMode({ running: true, explicit: true, historical: false })).toBe("loud");
  });

  it("a history download shows its progress even when nobody clicked", () => {
    expect(deriveUpdateMode({ running: true, explicit: false, historical: true })).toBe("loud");
  });
});

describe("landed cue", () => {
  it("a tick with news lands once; an unchanged tick or an FX update does not", () => {
    const qc = new QueryClient();
    applyRefreshEvent(qc, { type: "tick", last_update_at: "2026-11-23T15:31:00Z" });
    expect(getRefreshState().landed).toBe(1);
    applyRefreshEvent(qc, { type: "tick", unchanged: true });
    applyRefreshEvent(qc, { type: "fx", last_update_at: "2026-11-23T15:31:30Z" });
    expect(getRefreshState()).toMatchObject({ landed: 1, lastUpdateAt: "2026-11-23T15:31:30Z" });
  });
});

describe("one refetch wave per automatic update", () => {
  it("an automatic run's refetch waits for the tick that follows it", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    qc.setQueryData(["analytics", "EUR"], 1);
    applyRefreshEvent(qc, { type: "refresh_started", source: "Scheduled live refresh" });
    applyRefreshEvent(qc, { type: "refresh_finished" });
    // Marked stale (an inactive page refetches when opened), no refetch scheduled yet.
    expect(qc.getQueryState(["analytics", "EUR"])?.isInvalidated).toBe(true);
    expect(getRefreshState().landed).toBe(0);
    // The tick takes it over (live.ts then refetches the wider set in the tick's wave).
    expect(takeDeferredAutoRefetch()).toBe(true);
    expect(takeDeferredAutoRefetch()).toBe(false);
    vi.advanceTimersByTime(AUTO_REFETCH_WAIT_MS);
    expect(getRefreshState().landed).toBe(0);
  });

  it("without a tick the deferred refetch still runs and lands", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    applyRefreshEvent(qc, { type: "refresh_started", source: "Repair" });
    applyRefreshEvent(qc, { type: "refresh_finished" });
    vi.advanceTimersByTime(AUTO_REFETCH_WAIT_MS);
    expect(getRefreshState().landed).toBe(1);
    expect(takeDeferredAutoRefetch()).toBe(false);
  });

  it("the owner's own refresh refetches at once", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    qc.setQueryData(["analytics", "EUR"], 1);
    // useServerRefresh marks the run explicit before the server's events arrive.
    setRefreshState({ running: true, explicit: true, source: "manual" });
    applyRefreshEvent(qc, { type: "refresh_finished" });
    expect(qc.getQueryState(["analytics", "EUR"])?.isInvalidated).toBe(true);
    expect(takeDeferredAutoRefetch()).toBe(false);
    expect(getRefreshState().landed).toBe(0);
  });
});

describe("read activity", () => {
  it("api() counts GETs by who started them and settles them", async () => {
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((res) => (release = res))),
    );
    const pending = api("/api/overview", { background: true });
    expect(getReadActivity()).toEqual({ background: 1, foreground: 0 });
    release(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    await pending;
    expect(getReadActivity()).toEqual(none);
  });

  it("trackRead settles once", () => {
    const done = trackRead(false);
    done();
    done();
    expect(getReadActivity()).toEqual(none);
  });
});

describe("explicit flag", () => {
  it("a scheduled refresh_started is not explicit; finishing clears it", () => {
    const qc = new QueryClient();
    applyRefreshEvent(qc, { type: "refresh_started", source: "scheduled" });
    expect(getRefreshState()).toMatchObject({ running: true, explicit: false });
    applyRefreshEvent(qc, { type: "refresh_finished" });
    expect(getRefreshState()).toMatchObject({ running: false, explicit: false });
  });
});
