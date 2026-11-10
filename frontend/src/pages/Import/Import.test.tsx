import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { Import } from "./Import";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

const preview = {
  account_id: 1,
  can_confirm: true,
  parser: "standard",
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
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <Link to="/elsewhere">leave</Link>
            <Import />
          </>
        ),
      },
      { path: "/elsewhere", element: <p>elsewhere page</p> },
    ],
    { initialEntries: ["/"] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
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
    await userEvent.click(screen.getByRole("button", { name: "Import 1 transaction" }));
    expect((await screen.findAllByText(/Imported 1 transaction/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Saved as import #10/)).toBeInTheDocument();
  });

  it("says rows don't add up, shows the warning in the row and resolves it there", async () => {
    const message = "amount -1300.00 does not reconcile with quantity*price (5*220.00=1100.00)";
    const flagged = {
      ...preview,
      counts: { ...preview.counts, warnings: 1, unresolved: 1 },
      warnings: [{ message, line: 2, raw: "" }],
      rows: [{ ...preview.rows[0], warnings: [message], fixes: ["keep", "fix_price", "skip"], resolution: null }, preview.rows[1]],
    };
    const resolved = {
      ...flagged,
      import_id: "imp2",
      counts: { ...flagged.counts, unresolved: 0 },
      rows: [{ ...flagged.rows[0], price_native: "260", resolution: "fix_price" }, preview.rows[1]],
    };
    stubUpload(flagged);
    const fetchMock = stubFetch((url) =>
      url.includes("/api/imports/imp1/resolve") ? new Response(JSON.stringify(resolved), { status: 200 }) : undefined,
    );
    renderPage();
    await uploadFile();
    expect(await screen.findByText("1 row doesn't add up")).toBeInTheDocument();
    // No "Line 2:" list at the top: the warning sits in its row.
    expect(screen.queryByText(/Line 2/)).not.toBeInTheDocument();
    expect(screen.getByText(/Amount 1[.,]300 doesn.t match 5 × 220 = 1[.,]100/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fix price" }));
    expect(await screen.findByText("All flagged rows are resolved")).toBeInTheDocument();
    expect(screen.getByText("Price recalculated from the amount")).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/resolve"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ rows: [{ index: 1, action: "fix_price" }] });
  });

  it("asks before leaving a pending preview and cancels the import on the server", async () => {
    stubUpload(preview);
    const fetchMock = stubFetch();
    const router = renderPage();
    await uploadFile();
    await screen.findByText("Duplicate");
    await userEvent.click(screen.getByText("leave"));
    await userEvent.click(await screen.findByRole("button", { name: "Stay here" }));
    expect(router.state.location.pathname).toBe("/");
    await userEvent.click(screen.getByText("leave"));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel import and leave" }));
    expect(router.state.location.pathname).toBe("/elsewhere");
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/api/imports/imp1") && i?.method === "DELETE")).toBe(true);
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

  describe("flexible importer", () => {
    const layoutOf = (questions: object[]) => ({
      sheets: ["Sheet1"],
      sheet: 0,
      header_row: 0,
      columns: [
        { index: 0, header: "Datum", samples: ["01.05.2026"], field: "date", confidence: 1, by: "header" },
        { index: 1, header: "Kurs", samples: ["105,50", "110,25"], field: null, confidence: 0, by: null },
      ],
      fields: [
        { id: "date", label: "Date", help: "", required: true },
        { id: "price", label: "Price", help: "", required: false },
      ],
      decimal: ",",
      date_order: "DMY",
      derive: [],
      questions,
      notes: [],
      signature: "sig",
    });
    const flexible = (questions: object[], canConfirm = false) => ({
      ...preview,
      parser: "flexible",
      layout: layoutOf(questions),
      can_confirm: canConfirm,
    });
    const priceQuestion = (can_derive: boolean) => ({
      field: "price",
      message: "Which column holds the price?",
      can_derive,
      derive_hint: "price = amount / quantity",
    });

    it("offers three answers when the field can be derived", async () => {
      stubUpload(flexible([priceQuestion(true)]));
      stubFetch();
      renderPage();
      await uploadFile();
      expect(await screen.findByText("Which column holds the price?")).toBeInTheDocument();
      expect(screen.getByText("Pick a column")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Work it out from the other columns/ })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Cancel import" })).toHaveLength(1);
      expect(screen.getByText("Read with the flexible importer")).toBeInTheDocument();
    });

    it("hides the derive option when it cannot be derived", async () => {
      stubUpload(flexible([priceQuestion(false)]));
      stubFetch();
      renderPage();
      await uploadFile();
      expect(await screen.findByText("Pick a column")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Work it out/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel import" })).toBeInTheDocument();
    });

    it("posts the derive answer and swaps in the new preview", async () => {
      stubUpload(flexible([priceQuestion(true)]));
      const fetchMock = stubFetch((url, init) =>
        url.endsWith("/api/imports/imp1/layout") && init?.method === "POST"
          ? new Response(JSON.stringify({ ...flexible([], true), import_id: "imp2", filename: "a.csv (derived)" }), { status: 200 })
          : undefined,
      );
      renderPage();
      await uploadFile();
      await userEvent.click(await screen.findByRole("button", { name: /Work it out from the other columns/ }));
      expect(await screen.findByText(/a\.csv \(derived\)/)).toBeInTheDocument();
      const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/imp1/layout"));
      expect(JSON.parse(String(post![1]!.body))).toMatchObject({ derive: ["price"] });
      expect(screen.queryByText("Which column holds the price?")).not.toBeInTheDocument();
    });

    it("disables confirm while a question is open", async () => {
      stubUpload(flexible([priceQuestion(true)], false));
      stubFetch();
      renderPage();
      await uploadFile();
      expect(await screen.findByText("Answer the questions above first")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import 1 transaction" })).toBeDisabled();
    });

    it("shows the three date orders for a date_order question", async () => {
      stubUpload(flexible([{ field: "date_order", message: "01/05 is ambiguous.", can_derive: false, derive_hint: "" }]));
      stubFetch();
      renderPage();
      await uploadFile();
      expect(await screen.findByRole("button", { name: "Month/Day/Year (01/05 = 5 Jan)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Day/Month/Year (01/05 = 1 May)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Year-Month-Day" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel import" })).toBeInTheDocument();
    });
  });
});
