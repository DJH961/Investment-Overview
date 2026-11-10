import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import { QUERY_CACHE_KEY, clearClientData, flushPersist, persistOptions, persister, queryClient } from "./queries";

function seed() {
  queryClient.setQueryData(["holdings", "EUR"], [{ symbol: "X", value: 1 }]);
  localStorage.setItem(QUERY_CACHE_KEY, JSON.stringify({ clientState: { queries: [{ queryKey: ["holdings"] }] } }));
  sessionStorage.setItem("iv.scratch", "portfolio");
  localStorage.setItem("iv.theme", "dark");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("clearClientData", () => {
  it("drops cached queries and the persisted copy but keeps UI prefs", () => {
    seed();
    clearClientData();
    expect(queryClient.getQueryData(["holdings", "EUR"])).toBeUndefined();
    expect(localStorage.getItem(QUERY_CACHE_KEY)).toBeNull();
    expect(sessionStorage.getItem("iv.scratch")).toBeNull();
    expect(localStorage.getItem("iv.theme")).toBe("dark");
  });

  it("runs on any 401 from the API", async () => {
    seed();
    setUnauthorizedHandler(vi.fn());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "no" }), { status: 401 })));
    await expect(api("/api/holdings")).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData(["holdings", "EUR"])).toBeUndefined();
    expect(localStorage.getItem(QUERY_CACHE_KEY)).toBeNull();
  });
});

describe("persistence", () => {
  const client = { timestamp: 1, buster: "", clientState: { mutations: [], queries: [] } };

  it("does not write per change: only on flush (tab hidden) and never with graphs", async () => {
    persister.persistClient(client);
    persister.persistClient({ ...client, timestamp: 2 });
    expect(localStorage.getItem(QUERY_CACHE_KEY)).toBeNull();
    flushPersist();
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(QUERY_CACHE_KEY) ?? "null")?.timestamp).toBe(2));
    const keep = (k: string) => persistOptions.dehydrateOptions.shouldDehydrateQuery({ queryKey: [k], state: { status: "success" } });
    expect(keep("holdings")).toBe(true);
    expect(keep("graphs")).toBe(false);
    expect(keep("auth")).toBe(false);
  });

  it("a hidden tab flushes the pending copy", async () => {
    persister.persistClient({ ...client, timestamp: 5 });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(QUERY_CACHE_KEY) ?? "null")?.timestamp).toBe(5));
  });
});
