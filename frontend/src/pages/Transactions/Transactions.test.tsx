import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { Transactions } from "./Transactions";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));

const row = {
  id: 7,
  account: "Brokerage",
  account_id: 1,
  currency: "USD",
  date: "2026-01-05",
  kind: "buy",
  symbol: "VT",
  quantity: "2",
  price_native: "100.50",
  gross_native: "201.00",
  net_native: "-201.00",
  fees_native: "0",
  source: "manual",
  instrument_id: 3,
  cash_eur: "-182.7272727",
  cash_usd: "-201.00",
};
const page = {
  limit: 50,
  offset: 0,
  total: 1,
  rows: [row],
  months: [{ month: "2026-01", count: 4, net_eur: "-500", net_usd: "-550", fx_incomplete: false }],
  summary: { count: 1, buy_count: 1, sell_count: 0, avg_trade_size_eur: "0", avg_trade_size_usd: "0" },
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <Transactions />
          </MemoryRouter>
        </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function accountsAnd(handler: (url: string, init?: RequestInit) => Response | undefined) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/accounts"))
      return new Response(
        JSON.stringify([
          { id: 1, account_label: "Brokerage", account_type: "brokerage", active: true, broker: "fidelity", native_currency: "USD", transaction_count: 1 },
        ]),
        { status: 200 },
      );
    return handler(String(url), init) ?? new Response(JSON.stringify(page), { status: 200 });
  });
}

describe("Transactions", () => {
  it("lists rows and sends decimal strings on create", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/accounts"))
        return new Response(
          JSON.stringify([
            { id: 1, account_label: "Brokerage", account_type: "brokerage", active: true, broker: "fidelity", native_currency: "USD", transaction_count: 1 },
          ]),
          { status: 200 },
        );
      if (init?.method === "POST") return new Response(JSON.stringify({ transaction: row }), { status: 201 });
      return new Response(JSON.stringify(page), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    expect((await screen.findAllByText("VT")).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Add transaction" }));
    await userEvent.type(await screen.findByLabelText("Symbol"), "vt");
    await userEvent.type(screen.getByLabelText("Quantity"), "1.5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post![1]!.body));
    expect(body.quantity).toBe("1.5");
    expect(body.symbol).toBe("VT");
    expect(body.account_id).toBe(1);
  });

  it("shows an error state when the list fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "boom" }), { status: 500 })));
    renderPage();
    expect(await screen.findByText("Could not load transactions")).toBeInTheDocument();
  });

  it("formats numbers, groups by month and links to the instrument", async () => {
    vi.stubGlobal("fetch", accountsAnd(() => undefined));
    renderPage();
    expect(await screen.findByRole("button", { name: /January 2026/ })).toBeInTheDocument();
    expect(screen.getByText("4 transactions", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText("-€182.73").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-US$201.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("US$100.50").length).toBeGreaterThan(0);
    expect(screen.queryByText("-201.00 USD")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit instrument VT" })).toHaveAttribute("href", "/instruments?id=3");
  });

  it("asks the server for oldest-first and quick ranges", async () => {
    const fetchMock = accountsAnd(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Order: newest/ }));
    await userEvent.click(screen.getByRole("radio", { name: "This year" }));
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/transactions"));
    expect(urls.some((u) => u.includes("order=asc"))).toBe(true);
    expect(urls.at(-1)).toMatch(/start=\d{4}-01-01/);
  });

  it("checks quantity x price = total and defaults money-market auto-fill on", async () => {
    const fetchMock = accountsAnd((url) =>
      url.startsWith("/api/transactions/reconcile")
        ? new Response(JSON.stringify({ quantity: "2", price: "100", total: "200", filled: "total", error: null }), { status: 200 })
        : undefined,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add transaction" }));
    await userEvent.type(await screen.findByLabelText("Quantity"), "2");
    await userEvent.type(screen.getByLabelText("Price"), "100");
    await userEvent.tab();
    expect(await screen.findByText(/quantity x price = total OK/)).toBeInTheDocument();
    expect(screen.getByLabelText("Total (native)")).toHaveValue("200");
  });
});
