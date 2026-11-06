import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));
import type { OverviewDto } from "../../lib/queries/portfolio";
import { OverviewHero } from "./OverviewHero";

const base = {
  ccy: "EUR",
  secondary_ccy: "USD",
  kpis: { total_value: "200000", daily_move: "1500", daily_growth_pct: "0.0075", daily_growth_as_of: "2026-10-30" },
  kpis_secondary: { total_value: "216000", daily_growth_pct: "0.009" },
  daily_caption: { title: "Fri 30 Oct", as_of_text: "as of Fri 30 Oct", live: false, corner_text: null },
  currency: { return_split: { investment_return: "0.3", currency_effect_pp: "-0.012" } },
  freshness: { market_state: "closed", price_observed_at: "2026-11-02T08:00:00Z", last_price_update_at: null },
  total_value_complete: true,
} as unknown as OverviewDto;
// Monday 2 Nov 2026 before the US open: the move shown is Friday's.
const NOW = new Date("2026-11-02T09:00:00Z");

describe("OverviewHero", () => {
  it("shows both currencies, the day caption and the return split", () => {
    const { container } = render(<OverviewHero data={base} currency="EUR" loading={false} now={NOW} />);
    expect(screen.getByText("€200,000.00")).toBeInTheDocument();
    expect(screen.getByText("US$216,000.00")).toBeInTheDocument();
    expect(screen.getByText("+€1,500.00")).toBeInTheDocument();
    expect(screen.getByText("Last session · Fri")).toBeInTheDocument();
    // When the price is from vs when the app fetched it, both labelled.
    const stamps = container.querySelector(".overview-hero__stamps");
    expect(stamps).toHaveTextContent("Price as of Fri 20:00 (close)");
    expect(stamps).toHaveTextContent("Updated today 08:00");
    expect(screen.getByText("Investment +30.00% · Currency -1.20 pp")).toBeInTheDocument();
  });
  it("shows the live corner stamp and the incomplete-total note", () => {
    const live = {
      ...base,
      daily_caption: { title: "Today", as_of_text: "live", live: true, corner_text: "live" },
      total_value_complete: false,
    } as OverviewDto;
    const { container } = render(<OverviewHero data={live} currency="EUR" loading={false} now={NOW} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(container.querySelector(".overview-hero__corner--live")).not.toBeNull();
    expect(screen.getByText(/total is incomplete/)).toBeInTheDocument();
  });
  it("shows the overnight currency on its own line while the market is shut", () => {
    const shut = { ...base, last_session: { overnight_currency: "-120.5" } } as unknown as OverviewDto;
    render(<OverviewHero data={shut} currency="EUR" loading={false} now={NOW} />);
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("Overnight currency");
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("120.50");
  });
  it("hides the overnight line when there is no last-session split", () => {
    render(<OverviewHero data={base} currency="EUR" loading={false} now={NOW} />);
    expect(screen.queryByTestId("overnight-currency")).toBeNull();
  });

  const estimate = {
    total_value: "201600",
    daily_move: "3100",
    daily_growth_pct: "0.0156",
    adjustment: "1600",
    funds: [{ symbol: "FXAIX", twin: "VOO" }],
  };
  const estimating = {
    ...base,
    kpis: { ...base.kpis, estimate },
    kpis_secondary: {
      ...base.kpis_secondary,
      estimate: { ...estimate, total_value: "217728", daily_move: "3348", daily_growth_pct: "0.0158" },
    },
    // Shut market: last session (est.) + overnight currency (est.) = the headline day figure.
    last_session: {
      overnight_currency: "-120.5",
      overnight_currency_est: "-100",
      day_move: "1380",
      day_move_pct: "0.0069",
      move_est: "3200",
      move_pct_est: "0.016",
      estimated_funds: ["FXAIX"],
    },
  } as unknown as OverviewDto;

  it("without an estimate there is no chip and no official line", () => {
    render(<OverviewHero data={base} currency="EUR" loading={false} now={NOW} />);
    expect(screen.queryByTestId("hero-estimate-chip")).toBeNull();
    expect(screen.queryByTestId("hero-official")).toBeNull();
    expect(screen.queryByTestId("last-session-est")).toBeNull();
  });

  it("estimating: headline is the estimate with a chip, the official total sits in a small line", () => {
    const { container } = render(<OverviewHero data={estimating} currency="EUR" loading={false} now={NOW} />);
    expect(container.querySelector(".overview-hero__value")).toHaveTextContent("€201,600.00");
    expect(screen.getByTestId("hero-estimate-chip")).toHaveTextContent("≈ est.");
    expect(screen.getByRole("button", { name: "About the estimated total" })).toBeInTheDocument();
    const official = screen.getByTestId("hero-official");
    expect(official).toHaveTextContent("Official");
    expect(official).toHaveTextContent("€200,000.00");
    // Shut market: the official change since the previous close (incl. overnight
    // currency), as money AND percent — "how far off is the estimate" is a money
    // question, so the figure to compare the headline against is given in money.
    const change = screen.getByTestId("hero-official-change");
    expect(change).toHaveTextContent("+€1,380.00");
    expect(change).toHaveTextContent("+0.69%");
    // The open-market day move is not what a shut market reports.
    expect(official).not.toHaveTextContent("1,500");
    // Secondary currency follows its own estimate.
    expect(screen.getByText("US$217,728.00")).toBeInTheDocument();
  });

  it("open market, estimating: the small line is the plain official day move", () => {
    const open = {
      ...estimating,
      freshness: { ...base.freshness, market_state: "open" },
    } as unknown as OverviewDto;
    render(<OverviewHero data={open} currency="EUR" loading={false} now={NOW} />);
    // Open market: the plain official day move, money and percent.
    const change = screen.getByTestId("hero-official-change");
    expect(change).toHaveTextContent("+€1,500.00");
    expect(change).toHaveTextContent("+0.75%");
    // Not the shut-market figure, which folds in the overnight currency.
    expect(change).not.toHaveTextContent("1,380");
  });

  it("shut market, estimating: the day figure includes overnight and the split lines add up to it", () => {
    const { container } = render(<OverviewHero data={estimating} currency="EUR" loading={false} now={NOW} />);
    const move = container.querySelector(".overview-hero__move");
    expect(move).toHaveTextContent("+€3,100.00");
    expect(move).toHaveTextContent("+1.56%");
    expect(screen.getByTestId("last-session-est")).toHaveTextContent("+€3,200.00");
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("100.00");
    expect(screen.getByTestId("overnight-currency")).not.toHaveTextContent("120.50");
    // Both halves sit on one "<day> = a · b" line, so the headline move is visibly
    // their sum rather than a third unexplained figure.
    const breakdown = screen.getByTestId("day-breakdown");
    expect(breakdown).toHaveTextContent("Of which");
    expect(screen.getByTestId("last-session-est")).toHaveTextContent("Last session");
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("Overnight FX");
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("-€100.00");
  });

  it("not estimating: the overnight line keeps its own label and no breakdown prefix", () => {
    const shut = { ...base, last_session: { overnight_currency: "-120.5" } } as unknown as OverviewDto;
    render(<OverviewHero data={shut} currency="EUR" loading={false} now={NOW} />);
    expect(screen.queryByTestId("day-breakdown")).toBeNull();
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("Overnight currency");
  });
});
