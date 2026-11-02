import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import { QUERY_CACHE_KEY, clearClientData, queryClient } from "./queries";

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
