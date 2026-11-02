import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

import { Activity } from "./Activity";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const row = (over: Record<string, unknown>) => ({
  id: 1,
  date: "2025-03-10",
  account: "Main",
  kind: "deposit",
  amount_native: "1000",
  currency: "USD",
  amount: "800",
  amount_other: "1000",
  description: "March top-up",
  effective_rate: null,
  rate_source: null,
  conversion_batches: [],
  ...over,
});

const deposits = {
  ccy: "EUR",
  other_ccy: "USD",
  as_of: "2025-05-01",
  summary: { total_contrib: "1300", ytd_contrib: "1300", mtd_contrib: "0", total_contrib_native: "1500" },
  summary_other: { total_contrib: "1500", ytd_contrib: "1500", mtd_contrib: "0", total_contrib_native: "1500" },
  years: [2025, 2024],
  by_year: [
    { year: 2025, count: 2, total: "1300", total_other: "1500" },
    { year: 2024, count: 1, total: "400", total_other: "500" },
  ],
  rows: [
    row({
      effective_rate: "1.25",
      rate_source: "conversions",
      conversion_batches: [{ conversion_id: 1, date: "2025-03-01", usd: "1000", eur: "800" }],
    }),
    row({ id: 2, date: "2025-04-10", amount_native: "500", amount: "500", amount_other: "625", rate_source: "ecb" }),
    row({ id: 3, date: "2024-12-01", amount_native: "500", amount: "400", amount_other: "500" }),
  ],
};

const dividends = {
  ccy: "EUR",
  other_ccy: "USD",
  as_of: "2025-05-01",
  lifetime_total: "48",
  lifetime_total_other: "50",
  ttm_total: "8",
  ttm_total_other: "10",
  yield_ttm: "0.004",
  yield_lifetime: "0.02",
  by_year: [{ year: 2025, count: 1, dividends: "8", interest: "0", dividends_other: "10", interest_other: "0" }],
  by_holding: [
    { symbol: "VTI", name: "Total", count: 1, lifetime: "8", ttm: "8", lifetime_other: "10", ttm_other: "10", last_date: "2025-04-01" },
  ],
  rows: [
    { id: 9, date: "2025-04-01", symbol: "VTI", account: "Main", kind: "reinvest", amount_native: "10", currency: "USD", amount: "8", amount_other: "10" },
  ],
};

function stub(urls: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes("/api/deposits/dividends")
        ? dividends
        : url.includes("/api/deposits")
          ? deposits
          : [{ id: 1, account_label: "Main", broker: "vanguard", native_currency: "USD", account_type: "brokerage", active: true }];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Activity />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Activity", () => {
  it("shows the conversion batch or the ECB rate for each deposit", async () => {
    stub();
    renderPage();
    expect(await screen.findByText(/Conversion .*1\.2500 USD\/EUR/)).toBeInTheDocument();
    expect(screen.getByText("ECB rate")).toBeInTheDocument();
  });

  it("groups contributions by year, with the description and a second-currency line", async () => {
    stub();
    renderPage();
    expect(await screen.findByRole("button", { name: /2025/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /2024/ })).toHaveAttribute("aria-expanded", "false"); // older years start folded
    expect(screen.getAllByText("March top-up").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1,000\.00/).length).toBeGreaterThan(0);
  });

  it("sends the chosen filters to the API and remembers them", async () => {
    const urls: string[] = [];
    stub(urls);
    renderPage();
    await screen.findByRole("combobox", { name: "Kind" });
    fireEvent.click(screen.getByRole("combobox", { name: "Kind" }));
    fireEvent.click(screen.getByRole("option", { name: "Withdrawals" }));
    await vi.waitFor(() => expect(urls.some((u) => u.includes("kind=withdrawal"))).toBe(true));
    expect(localStorage.getItem("iv.activity.kind")).toBe('"withdrawal"');
  });

  it("opens the dividends tab with KPIs, a by-holding table and a folded payment list", async () => {
    stub();
    renderPage();
    fireEvent.click(await screen.findByRole("radio", { name: "Dividends" }));
    expect(await screen.findByText("Lifetime dividends")).toBeInTheDocument();
    expect(screen.getByText("By holding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All payments/ })).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("iv.activity.tab")).toBe('"dividends"');
  });
});
