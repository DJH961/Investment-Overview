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
    // "Price move" leads: the day is what you look at first. "Dividend income" is
    // gone — the stat strip right below already carries dividend return and yield.
    // Total growth and Vs market sit together because both carry two lines beneath
    // them; the plain period figures finish the grid.
    for (const l of ["Price move", "Invested", "Total return", "XIRR", "Total growth", "Vs market", "YTD", "MTD"]) {
      expect(screen.getByText(l)).toBeInTheDocument();
    }
    expect(screen.getByText("€100,000.00")).toBeInTheDocument();
    expect(screen.getByText("US$110,000.00")).toBeInTheDocument();
    expect(screen.getByText("+6.00%")).toBeInTheDocument(); // YTD in USD
    expect(screen.getByText("Beating")).toBeInTheDocument();
    // One comparison per line: "You +25.00%" over "VT +20.00%".
    expect(screen.getByText("You").parentElement).toHaveTextContent("You+25.00%");
    expect(screen.getByText("VT").parentElement).toHaveTextContent("VT+20.00%");
    expect(screen.getByText("€150")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About XIRR" })).toBeInTheDocument();
  });

  it("Price move shows the server's price part, with the FX part under it", () => {
    const split = (overnight: boolean) =>
      ({
        ...data({ beating: true }),
        kpis: { ...kpis, daily_move: "300" },
        day_split: {
          price_move: "420",
          currency_move: "-120",
          price_move_secondary: "500",
          currency_move_secondary: "0",
          overnight,
          estimated: false,
        },
      }) as unknown as OverviewDto;
    const { rerender } = render(<KpiGrid data={split(true)} currency="EUR" loading={false} />);
    expect(screen.getByText("+€420.00")).toBeInTheDocument();
    expect(screen.getByText("+US$500.00")).toBeInTheDocument();
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("Overnight FX");
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("-€120.00");
    rerender(<KpiGrid data={split(false)} currency="EUR" loading={false} />);
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("FX since close");
  });

  it("Vs market: trailing and missing benchmark history", () => {
    const { rerender } = render(<KpiGrid data={data({ beating: false })} currency="EUR" loading={false} />);
    expect(screen.getByText("Trailing")).toBeInTheDocument();
    rerender(<KpiGrid data={data({ beating: null })} currency="EUR" loading={false} />);
    expect(screen.getByText("Need VT history")).toBeInTheDocument();
  });

  // The split explains the Total growth tile: reporting growth == investment
  // return + currency effect. The server takes the effect against whichever
  // currency is on screen, so neither view is missing a figure the other has.
  const withSplit = (effect: string) =>
    ({
      ...data({ beating: true }),
      currency: { return_split: { investment_return: "0.3", currency_effect_pp: effect } },
    }) as unknown as OverviewDto;

  it("explains Total growth with the investment / currency split in EUR", () => {
    render(<KpiGrid data={withSplit("-0.012")} currency="EUR" loading={false} />);
    const split = screen.getByTestId("hero-split");
    expect(split).toHaveTextContent("Investment +30.00%");
    expect(split).toHaveTextContent("Currency -1.20 pp");
  });

  it("drops only the currency clause when the rate did nothing — never the growth", () => {
    // A dollar return has no exchange-rate leg, so the server reports an effect of
    // 0 and the clause does not apply. The investment figure stays, so the USD view
    // is not missing a number the EUR view shows.
    render(<KpiGrid data={withSplit("0")} currency="USD" loading={false} />);
    const split = screen.getByTestId("hero-split");
    expect(split).toHaveTextContent("Investment +30.00%");
    expect(split).not.toHaveTextContent("Currency");
    expect(screen.getByText("Total growth")).toBeInTheDocument();
  });

  it("reports the year once: no second, unlike YTD figure under the XIRR tile", () => {
    // The XIRR tile used to carry a year-to-date XIRR as a hint. Beside a tile
    // literally called YTD reporting growth since 1 January, two different numbers
    // under the same word read as a contradiction rather than as two measures.
    render(<KpiGrid data={data({ beating: true })} currency="EUR" loading={false} />);
    expect(screen.getAllByText(/^YTD/)).toHaveLength(1);
  });
});
