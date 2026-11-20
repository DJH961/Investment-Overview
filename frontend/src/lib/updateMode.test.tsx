import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { applyRefreshEvent, deriveUpdateMode, getRefreshState, resetRefreshState } from "./refresh";
import { getReadActivity, resetReadActivity, trackRead } from "./updateActivity";
import { QueryClient } from "@tanstack/react-query";

const idle = { running: false, explicit: false, historical: false };
const none = { background: 0, foreground: 0 };

afterEach(() => {
  resetRefreshState();
  resetReadActivity();
  vi.unstubAllGlobals();
});

describe("deriveUpdateMode", () => {
  it("nothing in flight is idle", () => {
    expect(deriveUpdateMode({ refresh: idle, pageRefreshing: false, activity: none })).toBe("idle");
  });

  it("background reads (ticks, scheduled refetches) are quiet", () => {
    expect(deriveUpdateMode({ refresh: idle, pageRefreshing: true, activity: { background: 2, foreground: 0 } })).toBe("quiet");
  });

  it("a scheduled server refresh is quiet, an explicit one is loud", () => {
    expect(deriveUpdateMode({ refresh: { running: true, explicit: false, historical: false }, pageRefreshing: false, activity: none })).toBe("quiet");
    expect(deriveUpdateMode({ refresh: { running: true, explicit: true, historical: false }, pageRefreshing: false, activity: none })).toBe("loud");
  });

  it("a first load with nothing cached stays quiet (skeletons already say loading)", () => {
    expect(deriveUpdateMode({ refresh: idle, pageRefreshing: true, activity: { background: 1, foreground: 1 } })).toBe("quiet");
  });

  it("a refetch behind cached data (restore, login, stale) is quiet, never loud", () => {
    expect(deriveUpdateMode({ refresh: idle, pageRefreshing: true, activity: none, fetching: 3 })).toBe("quiet");
    expect(deriveUpdateMode({ refresh: idle, pageRefreshing: false, activity: none, fetching: 0 })).toBe("idle");
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
