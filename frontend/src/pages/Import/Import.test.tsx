import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { Import } from "./Import";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

const preview = {
  account_id: 1,
  broker: "fidelity",
  counts: { duplicates: 1, errors: 0, new: 1, rows: 2, sweeps_dropped: 0, warnings: 0 },
  errors: [],
  expires_at: "2026-01-01T00:00:00Z",
  filename: "a.csv",
  import_id: "imp1",
  rows: [
    { index: 1, date: "2026-01-02", kind: "buy", symbol: "VT", currency: "USD", is_duplicate: false, quantity: "1" },
    { index: 2, date: "2026-01-03", kind: "buy", symbol: "VXUS", currency: "USD", is_duplicate: true, quantity: "1" },
  ],
  unknown_actions: [],
  warnings: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("Import", () => {
  it("uploads, previews with duplicate flags, and confirms", async () => {
    class FakeXhr {
      status = 201;
      statusText = "Created";
      responseText = JSON.stringify(preview);
      upload: { onprogress: null | (() => void) } = { onprogress: null };
      withCredentials = false;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      open() {}
      setRequestHeader() {}
      send() {
        this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST")
          return new Response(
            JSON.stringify({
              import_id: "imp1",
              inserted: 1,
              duplicates: 1,
              errors: [],
              warnings: [],
              fx_missing_dates: [],
              sweeps_dropped: 0,
              unknown_actions: [],
              unresolved_symbols: [],
            }),
            { status: 200 },
          );
        if (String(_url).includes("/api/accounts") || String(_url).includes("/brokers"))
          return new Response("[]", { status: 200 });
        return new Response(JSON.stringify({ rows: [], total: 0, limit: 200, offset: 0, summary: {} }), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ToastProvider>
            <MemoryRouter>
              <Import />
            </MemoryRouter>
          </ToastProvider>
      </QueryClientProvider>,
    );
    const file = new File(["a,b"], "a.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("Broker file"), file);
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Duplicate")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Import 1 transactions" }));
    expect((await screen.findAllByText(/Imported 1 transactions/)).length).toBeGreaterThan(0);
  });
});
