import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { Transactions } from "./Transactions";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

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
};
const page = {
  limit: 50,
  offset: 0,
  total: 1,
  rows: [row],
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

afterEach(() => vi.unstubAllGlobals());

describe("Transactions", () => {
  it("lists rows and sends decimal strings on create", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
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
});
