import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OverviewDto } from "../../lib/queries/portfolio";
import { KpiGrid } from "./KpiGrid";

const kpis = {
  total_invested: "100000",
  capital_gain: "25000",
  total_return: "27000",
  xirr: "0.081",
  ytd_xirr: "0.05",
  total_growth_compounded: "0.25",
  ytd_growth: "0.04",
  mtd_growth: "-0.01",
  weighted_expense_ratio: "0.0012",
  annual_expense_cost: "150",
  dividend_yield_pct: "0.02",
  dividend_yield_ttm_pct: "0.015",
  dividends_ttm: "1800",
};
function data(verdict: Partial<OverviewDto["market_verdict"]>): OverviewDto {
  return {
    ccy: "EUR",
    secondary_ccy: "USD",
    kpis,
    kpis_secondary: { ...kpis, total_invested: "110000", ytd_growth: "0.06" },
    market_verdict: { benchmark_symbol: "VT", ...verdict },
  } as unknown as OverviewDto;
}

describe("KpiGrid", () => {
  it("shows the NiceGUI tile set with both currencies", () => {
    render(<KpiGrid data={data({ beating: true, portfolio_return: "0.25", benchmark_return: "0.2" })} currency="EUR" loading={false} />);
    for (const l of ["Invested", "Capital gain", "XIRR", "Vs market", "Total growth", "YTD", "MTD", "Total return"]) {
      expect(screen.getByText(l)).toBeInTheDocument();
    }
    expect(screen.getByText("€100,000.00")).toBeInTheDocument();
    expect(screen.getByText("US$110,000.00")).toBeInTheDocument();
    expect(screen.getByText("+6.00%")).toBeInTheDocument(); // YTD in USD
    expect(screen.getByText("YTD +5.00%")).toBeInTheDocument();
    expect(screen.getByText("Beating")).toBeInTheDocument();
    // One comparison per line: "You +25.00%" over "VT +20.00%".
    expect(screen.getByText("You").parentElement).toHaveTextContent("You+25.00%");
    expect(screen.getByText("VT").parentElement).toHaveTextContent("VT+20.00%");
    expect(screen.getByText("€150")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About XIRR" })).toBeInTheDocument();
  });

  it("Vs market: trailing and missing benchmark history", () => {
    const { rerender } = render(<KpiGrid data={data({ beating: false })} currency="EUR" loading={false} />);
    expect(screen.getByText("Trailing")).toBeInTheDocument();
    rerender(<KpiGrid data={data({ beating: null })} currency="EUR" loading={false} />);
    expect(screen.getByText("Need VT history")).toBeInTheDocument();
  });
});
