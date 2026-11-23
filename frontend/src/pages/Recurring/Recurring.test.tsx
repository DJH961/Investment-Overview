import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettleSheet } from "../../components/SettleSheet";
import { ToastProvider } from "../../components/Toast";
import type { EstimateRow } from "../../lib/queries/recurring";
import { Recurring } from "./Recurring";

const plan = (over: Record<string, unknown>) => ({
  id: 1,
  kind: "buy",
  unit: "months",
  every: 1,
  anchor: 25,
  start_date: "2026-04-25",
  end_date: null,
  status: "active",
  paused: false,
  account_id: 1,
  account: "Fidelity Main Brokerage Account With A Rather Long Label For Overflow Testing",
  instrument_id: 2,
  symbol: "FAKEL",
  amount: "200.000000",
  shares: null,
  provider: null,
  expected_fee: null,
  next_due: "2026-07-27",
  note: null,
  ...over,
});

function wrap(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Recurring", () => {
  it("shows short titles, proper provider and account names, and no needless .00", async () => {
    const plans = [
      plan({ legs: [{ id: 1, instrument_id: 2, symbol: "FAKEL", amount: "200.000000", shares: null }] }),
      plan({ id: 2, kind: "conversion", amount: "1000.000000", provider: "wise", account: null, legs: [], anchor: 28 }),
      plan({
        id: 3,
        unit: "weeks",
        anchor: 0,
        legs: [
          { id: 2, instrument_id: 2, symbol: "FAKEL", amount: "12.500000", shares: null },
          { id: 3, instrument_id: 3, symbol: "FAKEB", amount: null, shares: "1.5000" },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).startsWith("/api/recurring/plans")
          ? new Response(JSON.stringify(plans), { status: 200 })
          : new Response(JSON.stringify({ count: 0, rows: [], groups: [] }), { status: 200 }),
      ),
    );
    wrap(<Recurring />);
    expect(await screen.findByText("$200 FAKEL · every month on the 25th")).toBeInTheDocument();
    expect(screen.getByText("€1,000 via Wise · every month on the 28th")).toBeInTheDocument();
    expect(screen.getByText("$12.50 FAKEL + 1.5 sh FAKEB · every week on monday")).toBeInTheDocument();
    expect(screen.getAllByText(/^Fidelity Main Brokerage/)[0]).toBeInTheDocument();
  });
});

const buyDraft: EstimateRow = {
  row_type: "transaction",
  id: 9,
  plan_id: 1,
  due_date: "2026-06-25",
  date: "2026-06-25",
  label: "Fidelity Main",
  symbol: "FAKEL",
  currency: "USD",
  price: "259.903400",
  quantity: "0.76950000",
  total: "200.00",
  fees: "0",
  sent: null,
  received: null,
  price_dp: 6,
  quantity_dp: 4,
};

describe("SettleSheet", () => {
  it("steps total and shares, derives the price, and saves in one tap", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST" ? { settled: 1, remaining: 0 } : {}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    wrap(<SettleSheet rows={[buyDraft]} onClose={onClose} />);
    // The draft's own price, at the precision the stepper moves (259.903400 is padding).
    expect(await screen.findByText("259.9034")).toBeInTheDocument();
    // Total and shares are the big steppers; stepping the total never changes the shares.
    await userEvent.click(screen.getByRole("button", { name: /Total: decrease by 0\.01/ }));
    expect(screen.getByRole("button", { name: /Shares: 0\.7695/ })).toBeInTheDocument();
    expect(screen.getByText("259.8960")).toBeInTheDocument(); // 199.99 / 0.7695
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.rows[0]).toMatchObject({ row_type: "transaction", id: 9, price: "259.8960", quantity: "0.7695", total: "199.99" });
  });

  it("lets a typed price override the derived one without moving total or shares", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST" ? { settled: 1, remaining: 0 } : {}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    wrap(<SettleSheet rows={[buyDraft]} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: /Price per share \(typed\): increase by 0\.0001/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).rows[0]).toMatchObject({ price: "259.9035", quantity: "0.7695", total: "200.00" });
  });
});
