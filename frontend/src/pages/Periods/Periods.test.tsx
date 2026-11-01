import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import { Risk } from "../Risk";
import { Periods } from "./Periods";

// lib/shell.tsx hands out an unstable setShell (loops with useShellStatus); stub until fixed.
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

function wrap(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrefsProvider>
        {node}
      </PrefsProvider>
    </QueryClientProvider>,
  );
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("Periods", () => {
  it("renders rows and a dash for missing values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          as_of: "2026-10-31",
          ccy: "EUR",
          granularity: "monthly",
          rows: [
            {
              label: "2026-10",
              is_current: true,
              closing_value: "1000",
              growth_pct: "0.05",
              net_flow: null,
              contributions: "100",
              dividends: "0",
              interest: "0",
              opening_value: "900",
              period_growth_xirr: null,
              total_growth_compounded: null,
            },
          ],
        }),
      ),
    );
    wrap(<Periods />);
    expect((await screen.findAllByText("2026-10")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows an error state on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    wrap(<Periods />);
    expect(await screen.findByText("Could not load periods")).toBeInTheDocument();
  });
});

describe("Risk", () => {
  it("explains missing attribution", async () => {
    const nulls = Object.fromEntries(
      ["alpha", "beta", "cagr", "calmar", "cvar_95", "kurtosis", "max_drawdown", "sharpe", "skew", "sortino", "twr", "ulcer", "var_95", "volatility", "xirr", "risk_free_rate"].map((k) => [k, null]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ...nulls,
          as_of: "2026-10-31",
          attribution: [],
          attribution_currency: null,
          benchmark_is_funded: true,
          benchmark_symbol: "VT",
          ccy: "EUR",
          currency: "EUR",
          curve: [{ date: "2026-10-30", portfolio_value: "10", benchmark_value: "9", cumulative_contributions: "8" }],
          curve_start: "2026-10-30",
          risk_free_symbol: "^IRX",
          start: "2026-01-01",
        }),
      ),
    );
    wrap(<Risk />);
    expect(await screen.findByText(/Attribution is only available in EUR/)).toBeInTheDocument();
  });
});
