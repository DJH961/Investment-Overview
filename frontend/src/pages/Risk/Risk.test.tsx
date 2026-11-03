import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import { Risk } from "./Risk";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

const metrics = Object.fromEntries(
  ["alpha", "beta", "cagr", "calmar", "cvar_95", "kurtosis", "max_drawdown", "sharpe", "skew", "sortino", "twr", "ulcer", "var_95", "volatility", "xirr"].map((k) => [k, "0.05"]),
);

const body = {
  ...metrics,
  as_of: "2026-10-31",
  start: "2026-01-01",
  curve_start: "2026-01-01",
  ccy: "EUR",
  currency: "EUR",
  risk_free_rate: "0.03",
  risk_free_symbol: "RF",
  benchmark_symbol: "BM",
  benchmark_is_funded: true,
  portfolio_last_value: "120",
  net_invested_last: "100",
  benchmark_last_value: "100",
  benchmark_diff: "20",
  benchmark_diff_pct: "0.2",
  curve: [{ date: "2026-10-30", portfolio_value: "120", benchmark_value: "100", cumulative_contributions: "100" }],
  attribution: [
    { instrument_id: 1, symbol: "AAA", start_value: "10", end_value: "15", net_contribution: "0", absolute_pnl: "5", pct_of_total_return: "1" },
  ],
  attribution_total: { start_value: "10", end_value: "15", net_contribution: "0", absolute_pnl: "5" },
  attribution_currency: "EUR",
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function mount() {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ EUR: body, USD: body }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrefsProvider>
        <MemoryRouter>
          <Risk />
        </MemoryRouter>
      </PrefsProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe("Risk", () => {
  it("shows grouped KPIs, benchmark tiles and the attribution total", async () => {
    mount();
    expect(await screen.findByText("Risk and volatility")).toBeInTheDocument();
    expect(screen.getByText("Risk-free rate")).toBeInTheDocument();
    expect(screen.getByText("vs BM (funded)")).toBeInTheDocument();
    expect(screen.getByLabelText("Attribution total")).toHaveTextContent("P&L");
    expect(screen.getByRole("radio", { name: "5Y" })).toBeInTheDocument();
  });

  it("remembers the lookback", async () => {
    const fetchMock = mount();
    await screen.findByText("Returns");
    fireEvent.click(screen.getByRole("radio", { name: "5Y" }));
    expect(window.localStorage.getItem("iv.risk.lookback")).toBe('"1825"');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("lookback_days=1825"))).toBe(true));
  });
});
