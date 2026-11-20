import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import { dehydrate, hydrate } from "@tanstack/react-query";
import { APP_VERSION } from "./appVersion";
import { logout } from "./auth";
import {
  PERSIST_MAX_AGE,
  QUERY_CACHE_KEY,
  clearClientData,
  flushPersist,
  onCacheRestored,
  persistOptions,
  persister,
  queryClient,
} from "./queries";

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
    for (const k of ["overview", "holdings", "graphs", "currency", "brief"]) expect(keep(k)).toBe(true);
    // An allow-list: auth, settings and the ledger never reach storage.
    for (const k of ["auth", "settings", "accounts", "transactions", "diagnostics", "something-new"]) expect(keep(k)).toBe(false);
  });

  it("a hidden tab flushes the pending copy", async () => {
    persister.persistClient({ ...client, timestamp: 5 });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(QUERY_CACHE_KEY) ?? "null")?.timestamp).toBe(5));
  });
});

describe("cache restore", () => {
  it("is tied to the app version and a 24 h max age", () => {
    expect(persistOptions.buster).toBe(APP_VERSION);
    expect(persistOptions.maxAge).toBe(PERSIST_MAX_AGE);
    expect(PERSIST_MAX_AGE).toBe(24 * 60 * 60 * 1000);
  });

  it("marks restored report queries stale; auth is left alone", () => {
    queryClient.setQueryData(["overview", "both"], "old");
    queryClient.setQueryData(["auth", "me"], { authenticated: true });
    onCacheRestored(queryClient);
    expect(queryClient.getQueryState(["overview", "both"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["auth", "me"])?.isInvalidated).toBe(false);
  });

  it("restored data never overrides fresher live data", () => {
    queryClient.setQueryData(["overview", "both"], "stale-from-storage", { updatedAt: 1_000 });
    const saved = dehydrate(queryClient);
    queryClient.setQueryData(["overview", "both"], "live-tick", { updatedAt: 2_000 });
    hydrate(queryClient, saved);
    expect(queryClient.getQueryData(["overview", "both"])).toBe("live-tick");
  });

  it("falls back to no cache when storage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(persister.restoreClient()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("sign out wipes the persisted copy", async () => {
    seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await logout();
    expect(localStorage.getItem(QUERY_CACHE_KEY)).toBeNull();
    expect(queryClient.getQueryData(["holdings", "EUR"])).toBeUndefined();
  });
});
