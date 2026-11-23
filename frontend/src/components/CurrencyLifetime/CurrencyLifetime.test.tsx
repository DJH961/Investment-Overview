import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OverviewDto } from "../../lib/queries/portfolio";
import { setHideAmounts } from "../../lib/format";
import { HideAmountsProvider } from "../../lib/hideAmounts";
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

afterEach(() => {
  localStorage.clear();
  setHideAmounts(false);
});

describe("CurrencyLifetime", () => {
  it("shows rate vs average, headwind coloring, FX effect and cash-out value", () => {
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
  it("USD view (P12): the dollar vs the euro and the EUR-minus-USD gap instead of a 0", () => {
    const usd = {
      ...data("0.0545"),
      ccy: "USD",
      currency: {
        ...data("0.0545").currency,
        return_split: {
          currency_effect_pp: "0",
          eur_minus_usd_pp: "-0.031",
          usd_vs_eur_pct: "-0.0517",
          investment_return: "0.4",
          total_return_eur: "0.369",
        },
      },
    } as unknown as OverviewDto;
    const { container } = render(<CurrencyLifetime data={usd} />);
    expect(screen.getByText("Dollar vs euro since buying")).toBeInTheDocument();
    expect(screen.getByTestId("lifetime-rate-move")).toHaveTextContent("-5.17%");
    expect(screen.getByText("headwind")).toBeInTheDocument();
    expect(screen.getByText("In euros vs dollars")).toBeInTheDocument();
    expect(screen.getByTestId("lifetime-fx-gap")).toHaveTextContent("-3.10 pp");
    expect(screen.queryByText("0.00 pp")).not.toBeInTheDocument();
    // One shape in both views: same tiles, same lines.
    const nUsd = container.querySelectorAll(".currency-lifetime__stat dd").length;
    const eur = render(<CurrencyLifetime data={data("0.0545")} />);
    expect(eur.container.querySelectorAll(".currency-lifetime__stat dd").length).toBe(nUsd);
  });
  it("a weaker euro is a tailwind", () => {
    render(<CurrencyLifetime data={data("-0.02")} />);
    expect(screen.getByText("tailwind")).toBeInTheDocument();
  });
  it("hide mode shows the FX gain/loss as a share of the cash-out value", () => {
    localStorage.setItem("iv.privacy.hideAmounts", "true");
    render(
      <HideAmountsProvider>
        <CurrencyLifetime data={data("0.0545")} />
      </HideAmountsProvider>,
    );
    expect(screen.getByText("-1.39%")).toBeInTheDocument(); // -2500 / 180000
    expect(screen.queryByText("-€2,500")).not.toBeInTheDocument();
  });
});
