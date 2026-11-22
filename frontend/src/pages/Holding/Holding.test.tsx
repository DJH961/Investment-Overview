import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultPoints = [
  { t: "2026-10-29", v: "95", value_eur: "950", value_usd: "1020", invested_eur: "800", invested_usd: "860" },
  { t: "2026-10-30", v: "100", value_eur: "1000", value_usd: "1080", invested_eur: "800", invested_usd: "860" },
];

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  phone: false,
  costScale: "auto" as "auto" | "always" | "never",
  avgPrice: "80",
  points: [
    { t: "2026-10-29", v: "95", value_eur: "950", value_usd: "1020", invested_eur: "800", invested_usd: "860" },
    { t: "2026-10-30", v: "100", value_eur: "1000", value_usd: "1080", invested_eur: "800", invested_usd: "860" },
  ],
}));

const base = {
  name: "World ETF",
  category: "Equity",
  asset_class: "etf",
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
  capital_gain: "200",
  cost_basis: "800",
  total_return: "212.5",
  dividends: "12.5",
  xirr: "0.08",
  today_pct: "0.01",
  today_move: "10",
  value_warning: false,
  price_data_warning: false,
};

const twin = {
  symbol: "VOO",
  tier: "manual",
  pending: true,
  at_close: false,
  est_today_pct: "0.0042",
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
    { ...base, instrument_id: 4, symbol: "FXAIX", name: "Index Fund", price_type: "nav", asset_class: "mutual_fund", twin },
    { ...base, instrument_id: 5, symbol: "FNOTW", name: "Fund Without Twin", price_type: "nav", asset_class: "mutual_fund" },
  ],
};

const tx = (id: number, symbol: string, kind = "buy", over: Record<string, unknown> = {}) => ({
  id,
  symbol,
  kind,
  account: "A",
  currency: "EUR",
  date: "2026-09-01",
  quantity: "2",
  price_native: "50",
  net_native: "-100",
  ...over,
});

const dividends = {
  as_of: "2026-10-30",
  rows: [
    { id: 1, symbol: "VWCE", kind: "cash", account: "A", currency: "EUR", date: "2026-06-01", amount: "12.5" },
    { id: 2, symbol: "VWRL", kind: "cash", account: "A", currency: "EUR", date: "2026-06-02", amount: "99" },
  ],
  by_holding: [
    {
      symbol: "VWCE",
      count: 1,
      lifetime: "12.5",
      ttm: "12.5",
      last_12m: "12.5",
      yield_ttm: "0.0125",
      by_year: [{ year: 2026, amount: "12.5" }],
      last_date: "2026-06-01",
      name: "World ETF",
    },
  ],
};

const lot = (id: number, status: string, days: number | null, over: Record<string, unknown> = {}) => ({
  id,
  account_id: 1,
  account_name: "A",
  acquired_on: "2025-01-10",
  source: "buy",
  quantity_bought: "4",
  quantity_left: "4",
  cost_per_share_native: "70",
  cost_native: "280",
  age_days: 400,
  long_term_on: "2026-01-11",
  days_to_long_term: days,
  status,
  gain_native: "120",
  gain_pct: "0.43",
  ...over,
});

const tranches = {
  instrument_id: 1,
  symbol: "VWCE",
  currency: "EUR",
  method: "fifo_view",
  as_of: "2026-10-30",
  price_native: "100",
  rows: [
    lot(1, "long", null),
    lot(2, "soon", 37),
    lot(3, "short", 200),
    lot(4, "long", null, { source: "reinvest", quantity_bought: "0.5", quantity_left: "0.5" }),
    lot(5, "short", 120, { source: "reinvest", quantity_bought: "0.5", quantity_left: "0.5" }),
  ],
  groups: [
    {
      account_id: 1,
      source: "reinvest",
      count: 2,
      quantity_left: "1",
      cost_native: "70",
      avg_cost_per_share_native: "70",
      gain_native: "30",
      gain_pct: "0.43",
      long_count: 1,
      short_count: 1,
      row_ids: [4, 5],
    },
  ],
  totals: {
    quantity_left: "13",
    position_quantity: "13",
    matches_position: true,
    long_quantity: "4.5",
    short_quantity: "8.5",
    fully_sold_count: 2,
  },
};

vi.mock("../../lib/useMediaQuery", async (orig) => ({
  ...(await orig<typeof import("../../lib/useMediaQuery")>()),
  useMediaQuery: () => state.phone,
  useIsPhone: () => state.phone,
}));
vi.mock("../../lib/queries/holdings", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/holdings")>()),
  useHoldings: () => ({ data: holdings, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../../lib/displayPrefs", async (orig) => {
  const actual = await orig<typeof import("../../lib/displayPrefs")>();
  return {
    ...actual,
    useDisplayPrefs: () => ({ ...actual.DEFAULT_DISPLAY_PREFS, holdingChartCostScale: state.costScale }),
  };
});
vi.mock("../../lib/queries/holding-detail", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/holding-detail")>()),
  useHoldingHistoryV2: (id: number, range: string, mode: string) => ({
    data: {
      instrument_id: id,
      symbol: "VWCE",
      ccy: "EUR",
      range,
      mode,
      x_mode: "date",
      sessions: [],
      points: state.points,
      trades: [],
      avg_price_native: state.avgPrice,
      period: { change_eur: "50", change_usd: "60", return_eur: "0.05", return_usd: "0.06", bought_eur: "0", bought_usd: "0", dividends_eur: "0", dividends_usd: "0" },
    },
    isPending: false,
    isFetching: false,
    isError: false,
  }),
  useHoldingTranches: () => ({ data: tranches, isPending: false, isError: false, refetch: vi.fn() }),
  useHoldingTwin: () => ({ data: undefined, isPending: true, isFetching: true, isError: false }),
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

function renderAt(entry: string | { pathname: string; state?: unknown }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/holdings/:id/:tab?" element={<Holding />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rangeNames = () => screen.getAllByRole("radio").map((r) => r.textContent);

beforeEach(() => {
  localStorage.clear();
  state.phone = false;
  state.costScale = "auto";
  state.avgPrice = "80";
  state.points = defaultPoints;
  state.rows = [tx(1, "VWCE"), tx(2, "VWCE", "sell", { net_native: "60", quantity: "-2", price_native: "30" }), tx(3, "VWRL")];
});

describe("Holding page", () => {
  it("opens on Performance: symbol and name on one line, tiles, chart and key facts", () => {
    renderAt("/holdings/1");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("VWCE");
    expect(h1).toHaveTextContent("World ETF");
    expect(h1).toHaveAttribute("title", "VWCE · World ETF");
    expect(screen.getByRole("tab", { name: "Performance" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Unrealised gain")).toBeInTheDocument();
    expect(screen.getByText("XIRR")).toBeInTheDocument();
    expect(screen.getByLabelText("VWCE value against money invested")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Key facts" })).toBeInTheDocument();
    expect(screen.getByText(/This range:/)).toBeInTheDocument();
    // Four tabs for a stock: no Twin.
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual([
      "Performance",
      "Tranches",
      "Transactions",
      "Dividends",
    ]);
  });

  it("redirects the old Details tab to Performance", () => {
    renderAt("/holdings/1/details");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/holdings\/1$/);
    expect(screen.getByRole("tab", { name: "Performance" })).toHaveAttribute("aria-selected", "true");
  });

  it("redirects an unknown tab to Performance", () => {
    renderAt("/holdings/1/nonsense");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/holdings\/1$/);
  });

  it("selects the tab named in the URL and switching a tab changes the URL", () => {
    renderAt("/holdings/1/dividends");
    expect(screen.getByRole("tab", { name: /Dividends/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Transactions/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/holdings/1/transactions");
  });

  it("a stock offers every range, 1D and 1W included", () => {
    renderAt("/holdings/1");
    expect(rangeNames()).toEqual(expect.arrayContaining(["1D", "1W", "1M", "All"]));
  });

  it("a NAV fund hides 1D / 1W and gets the Twin tab after Performance", () => {
    renderAt("/holdings/4");
    const ranges = rangeNames();
    expect(ranges).not.toContain("1D");
    expect(ranges).not.toContain("1W");
    expect(ranges).toContain("1M");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)[1]).toBe("Twin");
  });

  it("a NAV fund without a twin has no Twin tab and says it has no intraday price", () => {
    renderAt("/holdings/5");
    expect(screen.queryByRole("tab", { name: "Twin" })).toBeNull();
    expect(screen.getByText(/No intraday price for this fund/)).toBeInTheDocument();
    renderAt("/holdings/5/twin");
    expect(screen.getAllByTestId("where").at(-1)).toHaveTextContent(/^\/holdings\/5$/);
  });

  it("says so for an unknown holding", () => {
    renderAt("/holdings/99");
    expect(screen.getByText("We can't find this holding")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Holdings" })).toHaveAttribute("href", "/holdings");
  });

  describe("back link origin", () => {
    it("defaults to Holdings when opened directly without state", () => {
      renderAt("/holdings/1");
      expect(screen.getByRole("link", { name: "Holdings" })).toHaveAttribute("href", "/holdings");
    });

    it("returns to Overview when opened from Overview and keeps it across tabs and redirects", () => {
      renderAt({ pathname: "/holdings/1/details", state: { from: { to: "/overview", label: "Overview" } } });
      expect(screen.getByTestId("where")).toHaveTextContent(/^\/holdings\/1$/);
      expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/overview");
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Transactions/ }));
      expect(screen.getByTestId("where")).toHaveTextContent("/holdings/1/transactions");
      expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/overview");
    });
  });

  describe("chart cost scaling", () => {
    it("auto: hides flattening Invested on 1W by default and shows it when legend is toggled", () => {
      const { container } = renderAt("/holdings/1");
      fireEvent.click(screen.getByRole("radio", { name: "1W" }));
      expect(container.querySelector('[data-series="invested"]')).toBeNull();
      const toggle = screen.getByRole("button", { name: "Invested" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(container.querySelector('[data-series="invested"]')).not.toBeNull();
    });

    it("auto: keeps Invested visible on 1W when it sits close to Value", () => {
      state.points = [
        { t: "2026-10-29", v: "95", value_eur: "950", value_usd: "1020", invested_eur: "940", invested_usd: "1010" },
        { t: "2026-10-30", v: "100", value_eur: "1000", value_usd: "1080", invested_eur: "940", invested_usd: "1010" },
      ];
      const { container } = renderAt("/holdings/1");
      fireEvent.click(screen.getByRole("radio", { name: "1W" }));
      expect(container.querySelector('[data-series="invested"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: "Invested" })).toHaveAttribute("aria-pressed", "true");
    });

    it("auto: shows off-scale Avg cost cue in Price mode when far from the price range", () => {
      const { container } = renderAt("/holdings/1");
      fireEvent.click(screen.getByRole("radio", { name: "Price" }));
      expect(container.querySelector(".chart__reference-line")).toBeNull();
      expect(container.querySelector('[data-reference="offscale"]')).toHaveTextContent("↓ Avg cost €80.00");
    });

    it("always: keeps far-below Invested and Avg cost on-scale", () => {
      state.costScale = "always";
      const { container } = renderAt("/holdings/1");
      expect(container.querySelector('[data-series="invested"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: "Invested" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("radio", { name: "Price" }));
      expect(container.querySelector(".chart__reference-line")).not.toBeNull();
      expect(container.querySelector('[data-reference="offscale"]')).toBeNull();
    });

    it("never: hides even nearby Invested outside Value bounds and keeps nearby Avg cost off-scale", () => {
      state.costScale = "never";
      state.avgPrice = "92";
      state.points = [
        { t: "2026-10-29", v: "95", value_eur: "950", value_usd: "1020", invested_eur: "940", invested_usd: "1010" },
        { t: "2026-10-30", v: "100", value_eur: "1000", value_usd: "1080", invested_eur: "940", invested_usd: "1010" },
      ];
      const { container } = renderAt("/holdings/1");
      expect(container.querySelector('[data-series="invested"]')).toBeNull();
      const toggle = screen.getByRole("button", { name: "Invested" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(toggle);
      expect(container.querySelector('[data-series="invested"]')).not.toBeNull();
      fireEvent.click(screen.getByRole("radio", { name: "Price" }));
      expect(container.querySelector(".chart__reference-line")).toBeNull();
      expect(container.querySelector('[data-reference="offscale"]')).toHaveTextContent("↓ Avg cost €92.00");
    });
  });

  describe("Tranches", () => {
    it("badges carry a word for every status, reinvests fold into one group row", () => {
      renderAt("/holdings/1/tranches");
      const table = screen.getByRole("table", { name: "Tranches of VWCE" });
      expect(within(table).getAllByText("Long-term")).toHaveLength(2);
      expect(within(table).getByText("Long-term in 37 d")).toBeInTheDocument();
      expect(within(table).getByText("Short-term · 200 d left")).toBeInTheDocument();
      // The two reinvests sit behind one group row until opened.
      const toggle = within(table).getByRole("button", { name: /2 reinvested/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(within(table).queryByText("Short-term · 120 d left")).toBeNull();
      fireEvent.click(toggle);
      expect(within(table).getByText("Short-term · 120 d left")).toBeInTheDocument();
      expect(screen.getByText(/= position/)).toBeInTheDocument();
      expect(screen.getByText("2 fully sold")).toBeInTheDocument();
    });

    it("phone: one two-line card per tranche", () => {
      state.phone = true;
      renderAt("/holdings/1/tranches");
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByText("Long in 37 d")).toBeInTheDocument();
    });
  });

  describe("Transactions", () => {
    it("desktop: only this holding's rows, grouped by year with the net bought", async () => {
      renderAt("/holdings/1/transactions");
      const table = await screen.findByRole("table", { name: "Transactions for VWCE" });
      expect(within(table).getByText("2026")).toBeInTheDocument();
      expect(within(table).getByText(/net bought/)).toHaveTextContent("net bought €40.00");
      expect(within(table).getByText("Sell")).toBeInTheDocument();
      expect(within(table).getAllByRole("button", { name: /^Edit / })).toHaveLength(2);
    });

    it("phone: every row two lines, kind and amount, then date · account and shares @ price", async () => {
      state.phone = true;
      renderAt("/holdings/1/transactions");
      const list = await screen.findByRole("list", { name: "Transactions for VWCE" });
      const rows = within(list).getAllByRole("button");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("Buy");
      expect(rows[0]).toHaveTextContent("2 sh @ €50.00");
      expect(rows[0]).toHaveTextContent(/A$|· A/);
      expect(within(list).getByText(/net bought/)).toBeInTheDocument();
    });

    it("filter chips count each kind and filter the list", async () => {
      renderAt("/holdings/1/transactions");
      await screen.findByRole("table", { name: "Transactions for VWCE" });
      expect(screen.getByRole("button", { name: "All 2" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Sells 1" }));
      expect(screen.getAllByRole("button", { name: /^Edit / })).toHaveLength(1);
      // A kind with nothing in it gets no chip.
      expect(screen.queryByRole("button", { name: /^Dividends/ })).toBeNull();
    });

    it("says when there are no transactions", async () => {
      state.rows = [tx(3, "VWRL")];
      renderAt("/holdings/1/transactions");
      expect(await screen.findByText("No transactions for VWCE yet.")).toBeInTheDocument();
    });
  });

  describe("Dividends", () => {
    it("tiles, a bar per year and only this holding's payments", () => {
      renderAt("/holdings/1/dividends");
      expect(screen.getByText("Lifetime")).toBeInTheDocument();
      expect(screen.getByText("Yield (TTM)")).toBeInTheDocument();
      expect(screen.getByLabelText("Dividends per year")).toHaveTextContent("ytd");
      const list = screen.getByRole("list", { name: "Dividends from VWCE" });
      // Every row here is a dividend: line 1 says how it was paid.
      expect(within(list).getAllByText("Cash")).toHaveLength(1);
      expect(screen.queryByText(/99\.00/)).toBeNull();
    });

    it("says when a holding paid no dividends", () => {
      renderAt("/holdings/3/dividends");
      expect(screen.getByText("No dividends from VT yet.")).toBeInTheDocument();
    });
  });
});
