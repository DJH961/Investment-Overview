import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { resetServerStatus, setServerStatus } from "./serverStatus";

const unavailable = () => new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

afterEach(() => {
  resetServerStatus();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("api() during an outage", () => {
  it("retries a GET quietly while the server restarts and then resolves", async () => {
    vi.useFakeTimers();
    setServerStatus({ kind: "restarting", version: "6.3.0", etaS: 20, since: Date.now() });
    const fetchMock = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable()).mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    const result = api<{ ok: boolean }>("/api/overview");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still fails fast when nothing is announced", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unavailable()));
    await expect(api("/api/overview")).rejects.toBeInstanceOf(ApiError);
  });

  it("never retries writes", async () => {
    setServerStatus({ kind: "lost", since: Date.now() });
    const fetchMock = vi.fn().mockResolvedValue(unavailable());
    vi.stubGlobal("fetch", fetchMock);
    await expect(api("/api/transactions", { method: "POST", body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the caller cancels", async () => {
    setServerStatus({ kind: "lost", since: Date.now() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unavailable()));
    const ctl = new AbortController();
    const result = api("/api/overview", { signal: ctl.signal });
    const assertion = expect(result).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort(new Error("cancelled"));
    await assertion;
  });
});
