import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));
import type { OverviewDto } from "../../lib/queries/portfolio";
import { DayFacts } from "./DayFacts";

const base = {
  secondary_ccy: "USD",
  kpis: { total_value: "200000", daily_move: "1500", daily_growth_pct: "0.0075", daily_growth_as_of: "2026-10-30" },
  freshness: { market_state: "closed" },
} as unknown as OverviewDto;

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
  last_session: {
    overnight_currency: "-120.5",
    overnight_currency_est: "-100",
    day_move: "1380",
    day_move_pct: "0.0069",
    move_est: "3200",
  },
} as unknown as OverviewDto;

describe("DayFacts", () => {
  it("splits the day into what prices did and what the rate did, each labelled", () => {
    render(<DayFacts data={estimating} currency="EUR" />);
    // 3,200 price move + (−100) overnight FX == the hero's +€3,100 headline.
    expect(screen.getByTestId("last-session-est")).toHaveTextContent("Price move");
    expect(screen.getByTestId("last-session-est")).toHaveTextContent("+€3,200.00");
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("Overnight FX");
    expect(screen.getByTestId("overnight-currency")).toHaveTextContent("-€100.00");
    // The estimated overnight figure, not the official one.
    expect(screen.getByTestId("overnight-currency")).not.toHaveTextContent("120.50");
  });

  it("gives the official total with its own change, in money and percent", () => {
    render(<DayFacts data={estimating} currency="EUR" />);
    const official = screen.getByTestId("hero-official");
    expect(official).toHaveTextContent("Official");
    expect(official).toHaveTextContent("€200,000.00");
    // Shut market: the change since the previous close, which folds in the overnight FX.
    const change = screen.getByTestId("hero-official-change");
    expect(change).toHaveTextContent("+€1,380.00");
    expect(change).toHaveTextContent("+0.69%");
    expect(change).not.toHaveTextContent("1,500");
  });

  it("uses the plain official day move while the market trades", () => {
    const open = { ...estimating, freshness: { market_state: "open" } } as unknown as OverviewDto;
    render(<DayFacts data={open} currency="EUR" />);
    const change = screen.getByTestId("hero-official-change");
    expect(change).toHaveTextContent("+€1,500.00");
    expect(change).toHaveTextContent("+0.75%");
    expect(change).not.toHaveTextContent("1,380");
  });

  it("drops the overnight FX figure when the rate did nothing to this currency", () => {
    // A dollar book reported in dollars cannot drift overnight: the figure is a
    // constant zero, so printing it would be noise dressed as a fact.
    const flat = {
      ...estimating,
      last_session: { ...estimating.last_session, overnight_currency_est: "0" },
    } as unknown as OverviewDto;
    render(<DayFacts data={flat} currency="USD" />);
    expect(screen.queryByTestId("overnight-currency")).toBeNull();
    // The price move is only meaningful beside the FX half, so it goes too.
    expect(screen.queryByTestId("last-session-est")).toBeNull();
    // The official total still stands on its own.
    expect(screen.getByTestId("hero-official")).toBeInTheDocument();
  });

  it("renders nothing at all when there is no estimate and no overnight drift", () => {
    const { container } = render(<DayFacts data={base} currency="EUR" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the overview is still loading", () => {
    const { container } = render(<DayFacts data={undefined} currency="EUR" />);
    expect(container).toBeEmptyDOMElement();
  });
});
