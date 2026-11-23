import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as rtlRender, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HoldingsDto } from "../../lib/queries/holdings";

const phone = vi.hoisted(() => ({ value: false }));
const realPeek = vi.hoisted(() => ({ value: false }));

const holdings: HoldingsDto = {
  as_of: "2026-10-30",
  ccy: "EUR",
  total_value: "1000",
  total_capital_gain: "100",
  total_return: "120",
  total_growth: "0.25",
  xirr: "0.1",
  dividend_income: "20",
  dividends_ttm: "5",
  dividend_yield_pct: "0.02",
  dividend_yield_ttm_pct: "0.005",
  weighted_expense_ratio: "0.002",
  annual_expense_cost: "2",
  fx: { pair: "USD/EUR", spot: "0.9234", move_pct: "-0.001", as_of: "2026-10-30", source: "eod" },
  group_by: "none",
  groups: [],
  holdings: [
    {
      instrument_id: 1,
      symbol: "VWCE",
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
      price_as_of: "2026-10-30",
      avg_price_native: "80",
      today_pct: "0.01",
      today_move: "10",
      capital_gain: "200",
      dividends: "20",
      total_return: "220",
      total_growth: "0.25",
      xirr: "0.1",
      updated_at: "2026-10-30T15:05:00Z",
      value_warning: true,
      price_data_warning: false,
    },
  ],
  summary: { in_profit: 1, in_loss: 0, gainers: 1, losers: 0 },
};

let groupOver: Record<string, unknown> = {};

const accountGroups = (): HoldingsDto => ({
  ...holdings,
  group_by: "account",
  groups: [
    {
      key: "A",
      count: 1,
      instrument_ids: [1],
      value: "1000",
      cost_basis: "800",
      capital_gain: "200",
      dividends: "20",
      total_return: "220",
      weight_pct: "1",
      total_growth: "0.275",
      today_move: "10",
      today_pct: "0.01",
      est_value: null,
      est_today_move: null,
      ...groupOver,
    },
  ],
});

const twinRow = (over: Record<string, unknown> = {}) => ({
  ...holdings.holdings[0],
  instrument_id: 7,
  symbol: "FXAIX",
  name: "Index Fund",
  price_type: "nav",
  asset_class: "mutual_fund",
  value_warning: false,
  cost_basis: "800",
  dividends: "20",
  total_return: "220",
  mtd_growth: "0.02",
  ytd_growth: "0.12",
  expense_ratio: "0.0015",
  weight_pct: "0.5",
  twin: {
    symbol: "VOO",
    tier: "same_index",
    est_price: "101.5",
    est_value: "1015",
    est_today_move: "15",
    est_today_pct: "0.0042",
    at: "2026-10-30T20:00:00Z",
    pending: true,
    divergence: {
      last_pp: "0.034",
      last_money: "-3.4",
      last_date: "2026-10-29",
      median_abs_pp: "0.052",
      bias_pp: "0.021",
      sessions: 17,
      window: 20,
    },
  },
  ...over,
});


vi.mock("../../lib/useMediaQuery", async (orig) => ({
  ...(await orig<typeof import("../../lib/useMediaQuery")>()),
  useMediaQuery: () => phone.value,
}));

vi.mock("../../lib/queries/holdings", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/holdings")>()),
  useHoldingHistory: () => ({
    data: {
      instrument_id: 1,
      symbol: "VWCE",
      range: "1y",
      ccy: "EUR",
      points: [
        { t: "2026-10-28", v: "90" },
        { t: "2026-10-29", v: "95" },
        { t: "2026-10-30", v: "100" },
      ],
    },
    isPending: false,
    isError: false,
  }),
  useHoldings: (_ccy: string, by: string) => ({
    data: by === "account" ? accountGroups() : holdings,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
const samplePeek = {
  instrument_id: 1,
  currency: "EUR",
  week: {
    currency: "EUR",
    points: [
      { t: "2026-10-26", value_native: "980" },
      { t: "2026-10-30", value_native: "1000" },
    ],
    return_eur: "0.012",
    return_usd: "0.01",
  },
  tranches: { open_count: 3, next_long_term_on: "2026-12-01", next_long_term_days: 31 },
  last_trade: { date: "2026-09-01", kind: "buy", quantity: "2", price_native: "50" },
  last_dividend: { date: "2026-06-01", reinvested: false, amount_native: "12.5", reinvested_quantity: null },
};

vi.mock("../../lib/queries/holding-detail", async (orig) => {
  const mod = await orig<typeof import("../../lib/queries/holding-detail")>();
  return {
    ...mod,
    useHoldingPeek: (instrumentId: number, enabled: boolean) =>
      realPeek.value
        ? mod.useHoldingPeek(instrumentId, enabled)
        : {
            data: samplePeek,
            isPending: false,
            isError: false,
          },
  };
});
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

import { setHideAmounts } from "../../lib/format";
import { HideAmountsProvider } from "../../lib/hideAmounts";
import { Holdings } from "./Holdings";

/** Every render sits in a router (the symbol cells are links) and a query client (lookup, peek). */
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}
const render = (ui: React.ReactElement, options?: RenderOptions) => rtlRender(ui, { wrapper: Wrapper, ...options });

beforeEach(() => {
  phone.value = false;
  realPeek.value = false;
  setHideAmounts(false);
  groupOver = {};
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Holdings page", () => {
  it("renders the table with row flags and a search box", () => {
    render(<Holdings />);
    expect(screen.getAllByText("VWCE").length).toBeGreaterThan(0);
    expect(screen.getByText("stale value")).toBeInTheDocument();
    expect(screen.getByLabelText("Search holdings")).toHaveAttribute("data-search");
  });

  it("links the symbol to the holding page", () => {
    render(<Holdings />);
    expect(screen.getByRole("link", { name: "Open VWCE" })).toHaveAttribute("href", "/holdings/1");
  });

  it("shows group subtotals when grouped", () => {
    render(<Holdings />);
    expect(screen.queryByLabelText(/^Subtotal/)).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Group by" }));
    fireEvent.click(screen.getByRole("option", { name: "By account" }));
    const sub = screen.getByLabelText("Subtotal A");
    // One row in table order: value, weight, day, unrealized gain (hidden on phones by
    // CSS; the (i) carries it there too), total return; cost basis / dividends behind the (i).
    for (const key of ["Value", "Weight", "Day", "Unrealized gain", "Total return"])
      expect(within(sub).getByText(key)).toBeInTheDocument();
    expect(within(sub).queryByText("P/L")).toBeNull();
    expect(within(sub).queryByText("Cost basis")).toBeNull();
    expect(within(sub).queryByText("Dividends")).toBeNull();
    expect(within(sub).getByRole("button", { name: "About cost basis, unrealized gain, dividends and the return percentage" })).toBeInTheDocument();
    expect(within(sub).getByText("+€10.00")).toBeInTheDocument();
    expect(within(sub).getByText("+€220.00")).toBeInTheDocument();
    expect(within(sub).getByText("+27.50%")).toBeInTheDocument(); // simple return on cost
    expect(within(sub).queryByText("≈ est.")).toBeNull();
    expect(localStorage.getItem("iv.holdings.group")).toBe('"account"');
  });

  it("phone: tapping a row opens the compact peek with the ways into the page, tapping again closes it", () => {
    phone.value = true;
    render(<Holdings />);
    const head = screen.getByRole("button", { name: /VWCE/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    const peek = screen.getByRole("region", { name: "VWCE at a glance" });
    expect(within(peek).getByText("3 open · long-term in 31 d")).toBeInTheDocument();
    expect(within(peek).getByText(/Buy 2 sh/)).toBeInTheDocument();
    expect(within(peek).getByText("Last dividend")).toBeInTheDocument();
    expect(within(peek).getByRole("link", { name: /Open VWCE/ })).toHaveAttribute("href", "/holdings/1");
    expect(within(peek).getByRole("link", { name: "Tranches" })).toHaveAttribute("href", "/holdings/1/tranches");
    expect(within(peek).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/holdings/1/transactions");
    // The old expansion and its sheet are gone.
    expect(screen.queryByRole("button", { name: "Price chart" })).toBeNull();
    fireEvent.click(head);
    expect(screen.queryByRole("region", { name: "VWCE at a glance" })).toBeNull();
  });

  it("desktop: the chevron at the row end opens the same peek as a full-width row", () => {
    const { container } = render(<Holdings />);
    const toggle = screen.getByRole("button", { name: "Show VWCE summary" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const open = screen.getByRole("button", { name: "Close VWCE summary" });
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".data-table__expanded")).not.toBeNull();
    const peek = screen.getByRole("region", { name: "VWCE at a glance" });
    expect(within(peek).getByRole("link", { name: /Open deep dive/ })).toHaveAttribute("href", "/holdings/1");
    fireEvent.click(open);
    expect(container.querySelector(".data-table__expanded")).toBeNull();
  });

  it("an empty portfolio offers an Import button, not just text", () => {
    const saved = holdings.holdings;
    holdings.holdings = [] as typeof saved;
    try {
      render(<Holdings />);
      expect(screen.getByRole("button", { name: "Import a broker file" })).toBeInTheDocument();
    } finally {
      holdings.holdings = saved;
    }
  });

  it("shows the summary as one strip, income, fee and FX included", () => {
    const { container } = render(<Holdings />);
    expect(container.querySelectorAll(".holdings-page__stats .holdings-page__stat")).toHaveLength(14);
    expect(screen.getByText("Dividend return")).toBeInTheDocument();
    expect(screen.getByText("Yield (TTM)")).toBeInTheDocument();
    expect(screen.getByText("Weighted expense")).toBeInTheDocument();
    expect(screen.getByText("FX USD/EUR")).toBeInTheDocument();
    expect(screen.getByText(/EOD · /)).toBeInTheDocument();
  });

  it("keeps the same summary stats when the FX block is absent (USD view)", () => {
    const fx = holdings.fx;
    holdings.fx = null;
    holdings.fx_eur_usd = "1.0830";
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelectorAll(".holdings-page__stats .holdings-page__stat")).toHaveLength(14);
      expect(screen.getByText("FX EUR/USD")).toBeInTheDocument();
    } finally {
      holdings.fx = fx;
    }
  });

  it("tints profitable rows and lists flagged symbols in one notice", () => {
    const { container } = render(<Holdings />);
    expect(container.querySelector(".holdings-page__row--gain")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Stale or zero value: VWCE");
  });

  it("tints a dividends-only cash fund as a gain, not as flat", () => {
    // A money-market fund holds its NAV at par: its capital gain is 0 by construction
    // and its whole return is income. Tinting on capital gain left it untinted (or, on
    // a rounding cent, orange) while its own Total return column read clearly positive.
    const rows = holdings.holdings;
    holdings.holdings = [{ ...rows[0], capital_gain: "-0.37", dividends: "240", total_return: "239.63" }];
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelector(".holdings-page__row--gain")).not.toBeNull();
      expect(container.querySelector(".holdings-page__row--loss")).toBeNull();
    } finally {
      holdings.holdings = rows;
    }
  });

  it("says the price time once in the header and only on rows that differ", () => {
    const fund = {
      ...holdings.holdings[0],
      instrument_id: 2,
      symbol: "FXAIX",
      name: "Index Fund",
      asset_class: "mutual_fund",
      price_as_of: "2026-10-29",
      value_warning: false,
    };
    const etf2 = { ...holdings.holdings[0], instrument_id: 3, symbol: "VUSA", value_warning: false };
    const saved = holdings.holdings;
    holdings.holdings = [saved[0], etf2, fund];
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelector(".holdings-page__stamps .price-stamps")).toHaveTextContent(/Price as of .*\(close\)/);
      const stamps = [...container.querySelectorAll(".holdings-page__row-stamp")];
      // Only the fund (a NAV, from another day) carries its own stamp; never called a close.
      expect(stamps).toHaveLength(1);
      expect(stamps[0]).toHaveTextContent(/\(NAV\)/);
      expect(stamps[0]).not.toHaveTextContent(/close/);
      // The market is shut: the ETFs on the latest close get the tick, the fund behind them does not.
      expect(container.querySelectorAll(".price-tick")).toHaveLength(2);
      expect(container.querySelector(".price-tick")).toHaveAttribute("data-tick", "Up to date with the latest close");
    } finally {
      holdings.holdings = saved;
    }
  });

  describe("session / overnight split of the day figure", () => {
    const withSplit = () => {
      const saved = holdings.holdings;
      holdings.holdings = [
        { ...saved[0], day_session_pct: "0.0055", day_overnight_pct: "-0.0045", day_overnight: "-4.5" },
      ] as typeof saved;
      return () => {
        holdings.holdings = saved;
      };
    };

    it("table: both parts on one line under the Day figure, no note above the table", () => {
      const restore = withSplit();
      try {
        render(<Holdings />);
        expect(screen.getByTestId("holding-day-split")).toHaveTextContent(/Session\s*\+0\.55%\s*Overnight\s*-0\.45%/);
      expect(screen.queryByTestId("overnight-note")).toBeNull(); // no note above the table
      } finally {
        restore();
      }
    });

    it("phone: its own line under the figures, in the same words as the graph", () => {
      phone.value = true;
      const restore = withSplit();
      try {
        const { container } = render(<Holdings />);
        expect(screen.getByTestId("holding-day-split")).toHaveTextContent(
          /Session\s*\+0\.55%\s*Overnight\s*-0\.45%/,
        );
        expect(container.querySelector(".holdings-page__item-head--split")).not.toBeNull();
        // The (i) is not a button inside the row button, and tapping it leaves the row shut.
        expect(container.querySelector("button button")).toBeNull();
        const toggle = screen.getByRole("button", { name: /VWCE/ });
        fireEvent.click(screen.getByRole("button", { name: "About session and overnight" }));
        expect(toggle).toHaveAttribute("aria-expanded", "false");
      } finally {
        restore();
      }
    });

    it("hidden while the market is open, when nothing moved and on a stale move", () => {
      // No split fields (market open / USD holding in USD).
      const { unmount } = render(<Holdings />);
      expect(screen.queryByTestId("holding-day-split")).toBeNull();
      unmount();
      phone.value = true;
      const phoneRender = render(<Holdings />);
      expect(screen.queryByTestId("holding-day-split")).toBeNull();
      expect(phoneRender.container.querySelector(".holdings-page__item-head--split")).toBeNull();
      phoneRender.unmount();
      // A greyed (earlier session's) move gets no split even if the fields were present.
      phone.value = false;
      const saved = holdings.holdings;
      holdings.holdings = [
        { ...saved[0], daily_is_stale: true, daily_growth_as_of: "2026-10-28", day_session_pct: "0.01", day_overnight_pct: "-0.01" },
      ] as typeof saved;
      try {
        render(<Holdings />);
        expect(screen.queryByTestId("holding-day-split")).toBeNull();
      } finally {
        holdings.holdings = saved;
      }
    });
  });

  it("on a phone shows today in money", () => {
    phone.value = true;
    const { container } = render(<Holdings />);
    // One holding: its price time is the list's, said once in the header, not on the row.
    expect(container.querySelector(".holdings-page__row-stamp")).toBeNull();
    expect(container.querySelector(".holdings-page__today")).toHaveTextContent("+€10.00"); // money move
    expect(container.querySelector(".holdings-page__today--stale")).toBeNull();
  });

  it("greys the today move when the daily move is stale", () => {
    phone.value = true;
    holdings.holdings[0].daily_is_stale = true;
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelector(".holdings-page__today--stale")).not.toBeNull();
      expect(container.querySelector(".holdings-page__today--stale")).toHaveTextContent(/an earlier session's move/);
    } finally {
      holdings.holdings[0].daily_is_stale = false;
    }
  });

  it("shows money only when the group return on cost is null", () => {
    groupOver = { total_growth: null };
    render(<Holdings />);
    fireEvent.click(screen.getByRole("combobox", { name: "Group by" }));
    fireEvent.click(screen.getByRole("option", { name: "By account" }));
    const sub = screen.getByLabelText("Subtotal A");
    expect(within(sub).getByText("+€220.00")).toBeInTheDocument();
    expect(within(sub).queryByText(/27\.50/)).toBeNull();
  });

  it("shows an estimate chip in the group value and day cells when funds are pending", () => {
    groupOver = { est_value: "1015", est_today_move: "25" };
    render(<Holdings />);
    fireEvent.click(screen.getByRole("combobox", { name: "Group by" }));
    fireEvent.click(screen.getByRole("option", { name: "By account" }));
    const sub = screen.getByLabelText("Subtotal A");
    expect(within(screen.getByTestId("group-est-value")).getByText("≈ est.")).toBeInTheDocument();
    expect(within(screen.getByTestId("group-est-value")).getByText("€1,015.00")).toBeInTheDocument();
    expect(within(screen.getByTestId("group-est-move")).getByText("+€25.00")).toBeInTheDocument();
    expect(within(sub).getByRole("button", { name: "About the estimated value" })).toBeInTheDocument();
  });

  it("lists a pending twin quietly in the symbol cell, and drops the line once the NAV posted", () => {
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      const { container, unmount } = render(<Holdings />);
      const line = container.querySelector(".holding-identity__twin");
      expect(line).toHaveTextContent(/≈\s*VOO\s*\+0\.42%/);
      unmount();
      holdings.holdings = [twinRow({ twin: { ...twinRow().twin, pending: false, est_price: null, est_value: null, est_today_move: null, est_today_pct: null, at: null } })] as typeof saved;
      const again = render(<Holdings />);
      expect(again.container.querySelector(".holding-identity__twin")).toBeNull();
    } finally {
      holdings.holdings = saved;
    }
  });

  it("puts the estimate under the published price and the value while the NAV is pending", () => {
    // The official NAV is the last one the fund actually published; the estimate
    // belongs beneath it, marked, so the figure that moved is never mistaken for
    // the figure of record.
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      const { container, unmount } = render(<Holdings />);
      const subs = [...container.querySelectorAll(".holdings-page__stack-sub")].map((n) => n.textContent);
      expect(subs.some((t) => t?.includes("101.50"))).toBe(true); // estimated price per share
      expect(subs.some((t) => t?.includes("1,015"))).toBe(true); // the holding at that estimate
      unmount();
      // NAV posted: nothing to estimate, so neither line is drawn.
      holdings.holdings = [
        twinRow({ twin: { ...twinRow().twin, pending: false, est_price: null, est_value: null } }),
      ] as typeof saved;
      const again = render(<Holdings />);
      const after = [...again.container.querySelectorAll(".holdings-page__stack-sub")].map((n) => n.textContent);
      expect(after.some((t) => t?.includes("101.50"))).toBe(false);
      expect(after.some((t) => t?.includes("1,015"))).toBe(false);
    } finally {
      holdings.holdings = saved;
    }
  });

  it("phone peek of a NAV fund carries the twin line from the row, not the old details list", () => {
    phone.value = true;
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      const { container } = render(<Holdings />);
      expect(container.querySelector(".holding-identity__twin")).toHaveTextContent(/VOO/);
      fireEvent.click(screen.getByRole("button", { name: /FXAIX/ }));
      const peek = screen.getByRole("region", { name: "FXAIX at a glance" });
      expect(within(peek).getByText("Twin")).toBeInTheDocument();
      expect(within(peek).getByText(/est. until the NAV/)).toBeInTheDocument();
      expect(container.querySelector(".holdings-page__detail")).toBeNull();
      expect(screen.queryByLabelText("ETF twin of FXAIX")).toBeNull();
    } finally {
      holdings.holdings = saved;
    }
  });

  it("hide mode masks twin money but keeps the percentages", () => {
    phone.value = true;
    localStorage.setItem("iv.privacy.hideAmounts", "true");
    const saved = holdings.holdings;
    holdings.holdings = [twinRow()] as typeof saved;
    try {
      const { container } = render(
        <HideAmountsProvider>
          <Holdings />
        </HideAmountsProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /FXAIX/ }));
      const text = container.ownerDocument.body.textContent ?? "";
      expect(text).not.toMatch(/1,015|3\.40|12\.50/);
      expect(text).toContain("+0.42%");
    } finally {
      holdings.holdings = saved;
    }
  });

  it("hide mode leaves no amount or share count in the DOM", () => {
    localStorage.setItem("iv.privacy.hideAmounts", "true");
    const { container } = render(
      <HideAmountsProvider>
        <Holdings />
      </HideAmountsProvider>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("••,•••");
    expect(text).toContain("VWCE");
    expect(text).not.toMatch(/1,000|1000|200\.00|120\.00|220\.00|10\.0000|€\s?10\.00/);
  });

  it("preloads peeks in bulk after idle so expanding a row needs no /peek request", async () => {
    realPeek.value = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url);
        if (url.endsWith("/api/holdings/peeks")) {
          return new Response(JSON.stringify({ peeks: { "1": samplePeek } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ detail: "unexpected" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(<Holdings />);
    await waitFor(() => expect(calls.some((u) => u.endsWith("/api/holdings/peeks"))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Show VWCE summary" }));
    const peek = await screen.findByRole("region", { name: "VWCE at a glance" });
    expect(within(peek).getByText("3 open · long-term in 31 d")).toBeInTheDocument();
    expect(within(peek).getByText(/Buy 2 sh/)).toBeInTheDocument();
    expect(calls.some((u) => u.endsWith("/api/holdings/1/peek"))).toBe(false);
  });

  it("falls back to /api/holdings/{id}/peek if /api/holdings/peeks fails", async () => {
    realPeek.value = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url);
        if (url.endsWith("/api/holdings/peeks")) {
          return new Response(JSON.stringify({ detail: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/api/holdings/1/peek")) {
          return new Response(JSON.stringify(samplePeek), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ detail: "unexpected" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(<Holdings />);
    await waitFor(() => expect(calls.some((u) => u.endsWith("/api/holdings/peeks"))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Show VWCE summary" }));
    const peek = await screen.findByRole("region", { name: "VWCE at a glance" });
    expect(await within(peek).findByText("3 open · long-term in 31 d")).toBeInTheDocument();
    expect(calls.some((u) => u.endsWith("/api/holdings/1/peek"))).toBe(true);
  });

  it("warms one row's peek immediately on pointer enter or focus before idle preload fires", async () => {
    realPeek.value = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url);
        if (url.endsWith("/api/holdings/1/peek")) {
          return new Response(JSON.stringify(samplePeek), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ peeks: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const desktop = render(<Holdings />);
    const toggle = screen.getByRole("button", { name: "Show VWCE summary" });
    fireEvent.pointerEnter(toggle);
    await waitFor(() => expect(calls.filter((u) => u.endsWith("/api/holdings/1/peek"))).toHaveLength(1));
    desktop.unmount();

    phone.value = true;
    render(<Holdings />);
    const mobileToggle = screen.getByRole("button", { name: /VWCE/ });
    fireEvent.focus(mobileToggle);
    await waitFor(() => expect(calls.filter((u) => u.endsWith("/api/holdings/1/peek"))).toHaveLength(2));
  });
});
