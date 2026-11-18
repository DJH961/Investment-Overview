import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHideAmounts } from "../../lib/format";
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

afterEach(() => setHideAmounts(false));

describe("KpiGrid", () => {
  it("shows the NiceGUI tile set with both currencies", () => {
    render(<KpiGrid data={data({ beating: true, portfolio_return: "0.25", benchmark_return: "0.2" })} currency="EUR" loading={false} />);
    // "Day move" leads: the day is what you look at first. "Dividend income" is
    // gone — the stat strip right below already carries dividend return and yield.
    // Total growth and Vs market sit together because both carry two lines beneath
    // them; the plain period figures finish the grid.
    for (const l of ["Day move", "Invested", "Total return", "XIRR", "Total growth", "Vs market", "YTD", "MTD"]) {
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

  describe("Day move tile: the Total only (the hero shows its parts once)", () => {
    const shut = (ls: Record<string, string | null> | null) =>
      ({
        ...data({ beating: true }),
        kpis: { ...kpis, daily_move: "300", total_value: "10000" },
        day_split: {
          price_move: "420",
          currency_move: "-120",
          price_move_secondary: "500",
          currency_move_secondary: "0",
          overnight: true,
          estimated: false,
        },
        last_session: ls ? { move: "420", overnight_currency: "-120", ...ls } : null,
      }) as unknown as OverviewDto;

    it("shows the server's day Total in both currencies", () => {
      render(<KpiGrid data={shut(null)} currency="EUR" loading={false} />);
      expect(screen.getByText("+€420.00")).toBeInTheDocument();
      expect(screen.getByText("+US$500.00")).toBeInTheDocument();
    });

    it("never repeats the ☀/☾ split or the FX figure, so EUR and USD have the same shape", () => {
      const tile = (c: "EUR" | "USD", d: OverviewDto) => {
        const { container, unmount } = render(<KpiGrid data={d} currency={c} loading={false} />);
        const html = [...container.querySelectorAll(".kpi-tile")][0]!;
        const shape = [...html.querySelectorAll("*")].map((n) => n.className).join("|");
        expect(screen.queryByTestId("kpi-day-split")).toBeNull();
        expect(screen.queryByTestId("overnight-currency")).toBeNull();
        unmount();
        return shape;
      };
      for (const d of [shut(null), shut({ move_pct: "0.0081", overnight_pct: "-0.0045" })]) {
        expect(tile("EUR", d)).toEqual(tile("USD", d));
      }
    });
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

  it("shows no Investment / Currency line under Total growth (owner, pass 4)", () => {
    // Investment equals the USD figure already on the tile, so the line only repeated it.
    for (const ccy of ["EUR", "USD"] as const) {
      const { unmount } = render(<KpiGrid data={withSplit("-0.012")} currency={ccy} loading={false} />);
      expect(screen.queryByTestId("hero-split")).toBeNull();
      expect(screen.getByText("Total growth")).toBeInTheDocument();
      unmount();
    }
  });

  it("reports the year once: no second, unlike YTD figure under the XIRR tile", () => {
    // The XIRR tile used to carry a year-to-date XIRR as a hint. Beside a tile
    // literally called YTD reporting growth since 1 January, two different numbers
    // under the same word read as a contradiction rather than as two measures.
    render(<KpiGrid data={data({ beating: true })} currency="EUR" loading={false} />);
    expect(screen.getAllByText(/^YTD/)).toHaveLength(1);
  });
});
