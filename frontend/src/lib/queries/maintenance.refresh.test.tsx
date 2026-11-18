import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useJobRun } from "./maintenance";

afterEach(() => vi.unstubAllGlobals());

function setup(job: string, runId: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: runId, job, status: "succeeded", started_at: "x" }), { status: 200 })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["overview", "both"], 1);
  qc.setQueryData(["graphs", "1w", "both"], 1);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  renderHook(() => useJobRun(runId), { wrapper });
  return qc;
}

describe("a repair run seen finishing by polling", () => {
  it("refreshes the reports when the stream is down", async () => {
    const qc = setup("graphs.reload", "run-a");
    await waitFor(() => expect(qc.getQueryState(["graphs", "1w", "both"])?.isInvalidated).toBe(true));
    expect(qc.getQueryState(["overview", "both"])?.isInvalidated).toBe(true);
  });

  it("leaves the reports alone for a backup job", async () => {
    const qc = setup("backup.create", "run-b");
    await waitFor(() => expect(qc.getQueryData(["maintenance", "run", "run-b"])).toBeTruthy());
    expect(qc.getQueryState(["overview", "both"])?.isInvalidated).toBe(false);
  });
});
