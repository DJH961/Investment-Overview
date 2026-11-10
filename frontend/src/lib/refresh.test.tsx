import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, screen } from "@testing-library/react";
import { ToastProvider } from "../components/Toast";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRefreshState, resetRefreshState, useServerRefresh } from "./refresh";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const status = (running: boolean) => ({
  running,
  seq: 1,
  source: "manual",
  historical: false,
  progress_done: 0,
  progress_total: 0,
  last_update_at: running ? null : "2026-11-02T15:00:00Z",
});

describe("useServerRefresh", () => {
  let qc: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient();
    qc.setQueryData(["periods", "EUR"], 1);
  });
  afterEach(() => {
    resetRefreshState();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("POSTs a forced refresh, polls status and refetches reports when done", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(202, status(true)))
      .mockResolvedValueOnce(json(200, status(false)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useServerRefresh(), { wrapper });
    await act(async () => result.current.start());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/refresh?force=true");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect(result.current.state.running).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/refresh/status");
    expect(getRefreshState()).toMatchObject({ running: false, lastUpdateAt: "2026-11-02T15:00:00Z" });
    expect(qc.getQueryState(["periods", "EUR"])?.isInvalidated).toBe(true);
  });

  it("treats 409 as already running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(409, { detail: "A refresh is already running" })));
    const { result } = renderHook(() => useServerRefresh(), { wrapper });
    await act(async () => result.current.start());
    expect(result.current.state.running).toBe(true);
  });

  it("clears the running state when the POST fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(500, { detail: "boom" })));
    const { result } = renderHook(() => useServerRefresh(), { wrapper });
    await act(async () => result.current.start());
    expect(result.current.state.running).toBe(false);
    expect(screen.getByText("Couldn't start a refresh")).toBeInTheDocument();
  });
});
