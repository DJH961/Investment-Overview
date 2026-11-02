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

const batch = {
  id: 9,
  created_at: "2026-01-04T10:00:00Z",
  account_id: 1,
  account_label: "Brokerage",
  broker: "fidelity",
  filename: "old.csv",
  row_count: 3,
  current_rows: 3,
  duplicate_count: 0,
  status: "active",
  actor: "owner",
  undone_at: null,
  undone_by: null,
  undone_rows: null,
  can_undo: true,
};
const confirmResult = {
  import_id: "imp1",
  import_batch_id: 10,
  inserted: 1,
  duplicates: 1,
  errors: [],
  warnings: [],
  fx_missing_dates: [],
  sweeps_dropped: 0,
  unknown_actions: [],
  unresolved_symbols: [],
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(extra: Handler = () => undefined) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const hit = extra(url, init);
    if (hit) return hit;
    if (url.includes("/api/accounts") || url.includes("/brokers")) return new Response("[]", { status: 200 });
    if (url.includes("/api/imports/batches/9/undo-preview"))
      return new Response(
        JSON.stringify({
          batch,
          rows: [{ id: 1, date: "2026-01-02", kind: "buy", symbol: "VT", quantity: "1.5", net_native: "-100", description: null }],
          rows_truncated: false,
          total: 3,
          detached: 0,
          earliest_date: "2026-01-02",
          latest_date: "2026-01-03",
          confirm_word: "UNDO",
        }),
        { status: 200 },
      );
    if (url.includes("/api/imports/batches"))
      return new Response(JSON.stringify({ batches: [batch], note: "Older imports are not listed." }), { status: 200 });
    if (url.includes("/confirm")) return new Response(JSON.stringify(confirmResult), { status: 200 });
    return new Response(JSON.stringify({ rows: [], total: 0, limit: 200, offset: 0, summary: {} }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubUpload(body: object) {
  class FakeXhr {
    status = 201;
    statusText = "Created";
    responseText = JSON.stringify(body);
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
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <Import />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function uploadFile() {
  await userEvent.upload(screen.getByLabelText("Broker file"), new File(["a,b"], "a.csv", { type: "text/csv" }));
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Import", () => {
  it("uploads, previews with duplicate flags, confirms and shows the batch", async () => {
    stubUpload(preview);
    stubFetch();
    renderPage();
    await uploadFile();
    expect(await screen.findByText("Duplicate")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Import 1 transactions" }));
    expect((await screen.findAllByText(/Imported 1 transactions/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Saved as import #10/)).toBeInTheDocument();
  });

  it("undoes a batch only after typing UNDO", async () => {
    const fetchMock = stubFetch((url, init) =>
      url.endsWith("/batches/9/undo") && init?.method === "POST"
        ? new Response(JSON.stringify({ batch: { ...batch, status: "undone" }, deleted: 3, backup: "b.zip", invalidated_from: "2026-01-02" }), {
            status: 200,
          })
        : undefined,
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Undo import old.csv" }));
    expect(await screen.findByText(/3 transactions in Brokerage/)).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Undo import" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type UNDO to confirm"), "UNDO");
    await userEvent.click(go);
    const post = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/undo") && i?.method === "POST");
    expect(JSON.parse(String(post![1]!.body))).toEqual({ confirm: "UNDO" });
    expect(await screen.findByText(/3 transactions removed/)).toBeInTheDocument();
  });

  it("explains a 403 on undo as a fresh sign-in", async () => {
    stubFetch((url, init) =>
      url.endsWith("/batches/9/undo") && init?.method === "POST"
        ? new Response(JSON.stringify({ detail: "This action needs a signed-in browser session." }), { status: 403 })
        : undefined,
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Undo import old.csv" }));
    await userEvent.type(await screen.findByLabelText("Type UNDO to confirm"), "UNDO");
    await userEvent.click(screen.getByRole("button", { name: "Undo import" }));
    expect(await screen.findByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
  });

  it("maps unknown actions and re-parses the preview", async () => {
    stubUpload({ ...preview, unknown_actions: ["JOURNALED"] });
    const fetchMock = stubFetch((url, init) => {
      if (url.includes("/api/imports/unknown-actions"))
        return new Response(
          JSON.stringify({
            import_id: "imp1",
            broker: "fidelity",
            filename: "a.csv",
            actions: [{ action: "JOURNALED", count: 2 }],
            targets: ["deposit", "ignore"],
            overrides: { JOURNALED: "deposit" },
          }),
          { status: 200 },
        );
      if (url.includes("/reparse") && init?.method === "POST")
        return new Response(JSON.stringify({ ...preview, import_id: "imp2", filename: "a.csv (re-parsed)" }), { status: 200 });
      return undefined;
    });
    renderPage();
    await uploadFile();
    expect(await screen.findByText(/JOURNALED/, { selector: "span" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Re-parse with these mappings" }));
    expect(await screen.findByText(/re-parsed/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/imports/imp1/reparse"))).toBe(true);
  });
});
