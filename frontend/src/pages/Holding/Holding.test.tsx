import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

const base = {
  name: "World ETF",
  category: "Equity",
  asset_class: "equity",
  account: "A",
  native_currency: "EUR",
  shares: "10",
  price_type: "market",
  is_money_market: false,
  market_open: false,
  daily_is_stale: false,
  value: "1000",
  price_native: "100",
  avg_price_native: "80",
  today_pct: "0.01",
  today_move: "10",
  value_warning: false,
  price_data_warning: false,
};

const holdings = {
  as_of: "2026-10-30",
  ccy: "EUR",
  group_by: "none",
  groups: [],
  holdings: [
    { ...base, instrument_id: 1, symbol: "VWCE" },
    { ...base, instrument_id: 2, symbol: "VWRL", name: "Other ETF" },
    { ...base, instrument_id: 3, symbol: "VT", name: "Third ETF" },
  ],
};

const tx = (id: number, symbol: string, kind = "buy") => ({
  id,
  symbol,
  kind,
  account: "A",
  currency: "EUR",
  date: "2026-09-01",
  quantity: "2",
  price_native: "50",
  net_native: "-100",
});

const dividends = {
  rows: [
    { id: 1, symbol: "VWCE", kind: "cash", account: "A", currency: "EUR", date: "2026-06-01", amount: "12.5" },
    { id: 2, symbol: "VWRL", kind: "cash", account: "A", currency: "EUR", date: "2026-06-02", amount: "99" },
  ],
  by_holding: [{ symbol: "VWCE", count: 1, lifetime: "12.5", ttm: "12.5", last_date: "2026-06-01", name: "World ETF" }],
};

vi.mock("../../lib/queries/holdings", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/holdings")>()),
  useHoldingHistory: () => ({ data: { instrument_id: 1, symbol: "VWCE", range: "1y", ccy: "EUR", points: [{ t: "2026-10-29", v: "95" }, { t: "2026-10-30", v: "100" }] }, isPending: false, isError: false }),
  useHoldings: () => ({ data: holdings, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../../lib/queries/activity", () => ({
  useDividends: () => ({ data: dividends, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../../lib/queries/ledger", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/ledger")>()),
  // The server's symbol filter is a prefix match; the page filters again.
  transactionsQuery: () => ({
    queryKey: ["transactions", "test"],
    queryFn: async () => ({ rows: state.rows, total: state.rows.length }),
  }),
}));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));

import { Holding } from "./Holding";

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname}</output>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/holdings/:id/:tab?" element={<Holding />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  state.rows = [tx(1, "VWCE"), tx(2, "VWCE", "sell"), tx(3, "VWRL")];
});

describe("Holding page", () => {
  it("opens on Details", () => {
    renderAt("/holdings/1");
    expect(screen.getByRole("heading", { name: "VWCE" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("VWCE price against cost basis")).toBeInTheDocument();
  });

  it("selects the tab named in the URL", () => {
    renderAt("/holdings/1/dividends");
    expect(screen.getByRole("tab", { name: /Dividends/ })).toHaveAttribute("aria-selected", "true");
  });

  it("switching a tab changes the URL", () => {
    renderAt("/holdings/1");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Transactions/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/holdings/1/transactions");
  });

  it("redirects an unknown tab to Details", () => {
    renderAt("/holdings/1/nonsense");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/holdings\/1$/);
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  });

  it("says so for an unknown holding", () => {
    renderAt("/holdings/99");
    expect(screen.getByText("We can't find this holding")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Holdings" })).toHaveAttribute("href", "/holdings");
  });

  it("lists only this holding's transactions", async () => {
    renderAt("/holdings/1/transactions");
    const table = await screen.findByRole("table", { name: "Transactions for VWCE" });
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    expect(within(table).getByText("Sell")).toBeInTheDocument();
  });

  it("says when there are no transactions", async () => {
    state.rows = [tx(3, "VWRL")];
    renderAt("/holdings/1/transactions");
    expect(await screen.findByText("No transactions for VWCE yet.")).toBeInTheDocument();
  });

  it("lists only this holding's dividends with its lifetime total", () => {
    renderAt("/holdings/1/dividends");
    const table = screen.getByRole("table", { name: "Dividends from VWCE" });
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header + 1
    expect(screen.getByText(/Lifetime from VWCE/)).toHaveTextContent("12.50");
    expect(screen.queryByText(/99\.00/)).toBeNull();
  });

  it("says when a holding paid no dividends", () => {
    renderAt("/holdings/3/dividends");
    expect(screen.getByText("No dividends from VT yet.")).toBeInTheDocument();
  });
});
