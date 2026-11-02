import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OverviewDto } from "../../lib/queries/portfolio";
import { CurrencyLifetime } from "./CurrencyLifetime";

const data = (rate_change_pct: string) =>
  ({
    currency: {
      lifetime: {
        current_rate: "1.1600",
        avg_invest_rate: "1.1000",
        rate_change_pct,
        fx_pnl_eur: "-2500",
        repatriation_value_eur: "180000",
        breakeven_rate: "1.0850",
      },
      return_split: { currency_effect_pp: "-0.031", investment_return: "0.4", total_return_eur: "0.369" },
    },
  }) as unknown as OverviewDto;

afterEach(() => localStorage.clear());

describe("CurrencyLifetime", () => {
  it("shows rate vs average, headwind colouring, FX effect and cash-out value", () => {
    const { container } = render(<CurrencyLifetime data={data("0.0545")} />);
    expect(screen.getByRole("button", { name: "Currency effect (lifetime)" })).toBeInTheDocument();
    expect(screen.getByText("1.1600")).toBeInTheDocument();
    expect(screen.getByText("avg in 1.1000")).toBeInTheDocument();
    expect(screen.getByText("headwind")).toBeInTheDocument();
    expect(container.querySelector(".currency-lifetime__value--neg")).toHaveTextContent("+5.45%");
    expect(screen.getByText("-3.10 pp")).toBeInTheDocument();
    expect(screen.getByText("-€2,500")).toBeInTheDocument();
    expect(screen.getByText("€180,000")).toBeInTheDocument();
    expect(screen.getByText("1.0850")).toBeInTheDocument();
  });
  it("a weaker euro is a tailwind", () => {
    render(<CurrencyLifetime data={data("-0.02")} />);
    expect(screen.getByText("tailwind")).toBeInTheDocument();
  });
});
