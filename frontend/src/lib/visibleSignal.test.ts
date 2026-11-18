import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { queryClient } from "./queries";

/** The tab-visible signal: `X-Visible: 1` on GETs, read at send time, only while "visible". */
function setVisibility(state: string) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  return calls[calls.length - 1][1].headers as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("X-Visible signal", () => {
  it("is sent while the tab is visible", async () => {
    setVisibility("visible");
    const f = stubFetch();
    await api("/api/brief");
    expect(sentHeaders(f)["X-Visible"]).toBe("1");
  });

  it.each(["hidden", "prerender"])("is not sent while the state is %s", async (state) => {
    setVisibility(state);
    const f = stubFetch();
    await api("/api/overview/both");
    expect(sentHeaders(f)["X-Visible"]).toBeUndefined();
  });

  it("is read at send time, never cached", async () => {
    const f = stubFetch();
    setVisibility("visible");
    await api("/api/brief");
    expect(sentHeaders(f)["X-Visible"]).toBe("1");
    setVisibility("hidden");
    await api("/api/brief");
    expect(sentHeaders(f)["X-Visible"]).toBeUndefined();
  });

  it("is not sent on writes", async () => {
    setVisibility("visible");
    const f = stubFetch();
    await api("/api/brief/ack", { method: "POST", body: { seen_at: null } });
    expect(sentHeaders(f)["X-Visible"]).toBeUndefined();
  });
});

describe("Brief refetch when the tab comes back", () => {
  it("invalidates the brief on visibilitychange to visible and on pageshow, never while hidden", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(spy).not.toHaveBeenCalled();
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["brief"] });
    spy.mockClear();
    window.dispatchEvent(new Event("pageshow"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["brief"] });
    spy.mockRestore();
  });
});
