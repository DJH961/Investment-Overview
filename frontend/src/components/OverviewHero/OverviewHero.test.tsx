import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OverviewDto } from "../../lib/queries/portfolio";
import { OverviewHero } from "./OverviewHero";

const base = {
  ccy: "EUR",
  secondary_ccy: "USD",
  kpis: { total_value: "200000", daily_move: "1500", daily_growth_pct: "0.0075" },
  kpis_secondary: { total_value: "216000", daily_growth_pct: "0.009" },
  daily_caption: { title: "Fri 30 Oct", as_of_text: "as of Fri 30 Oct", live: false, corner_text: null },
  currency: { return_split: { investment_return: "0.3", currency_effect_pp: "-0.012" } },
  total_value_complete: true,
} as unknown as OverviewDto;

describe("OverviewHero", () => {
  it("shows both currencies, the day caption and the return split", () => {
    render(<OverviewHero data={base} currency="EUR" loading={false} />);
    expect(screen.getByText("€200,000.00")).toBeInTheDocument();
    expect(screen.getByText("US$216,000.00")).toBeInTheDocument();
    expect(screen.getByText("+€1,500.00")).toBeInTheDocument();
    expect(screen.getByText("Fri 30 Oct")).toBeInTheDocument();
    expect(screen.getByText("Investment +30.00% · Currency -1.20 pp")).toBeInTheDocument();
  });
  it("shows the live corner stamp and the incomplete-total note", () => {
    const live = {
      ...base,
      daily_caption: { title: "Today", as_of_text: "live", live: true, corner_text: "live" },
      total_value_complete: false,
    } as OverviewDto;
    const { container } = render(<OverviewHero data={live} currency="EUR" loading={false} />);
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(container.querySelector(".overview-hero__corner--live")).not.toBeNull();
    expect(screen.getByText(/total is incomplete/)).toBeInTheDocument();
  });
});
