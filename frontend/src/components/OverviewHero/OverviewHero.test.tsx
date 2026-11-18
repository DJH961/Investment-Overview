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
    // Compact: an older session keeps its day and drops the clock, today keeps
    // the clock and drops the word. The full wording stays in each tooltip.
    const stamps = container.querySelector(".overview-hero__stamps");
    expect(stamps).toHaveTextContent("Fri (close)");
    expect(stamps).not.toHaveTextContent("20:00");
    expect(stamps).toHaveTextContent("Updated 08:00");
    expect(stamps).not.toHaveTextContent("today");
    // The supporting figures live in the KPI block now (see KpiGrid/DayFacts):
    // the hero is the value, the other currency and one change row, nothing else.
    expect(screen.queryByTestId("hero-split")).toBeNull();
    // Nothing is estimating here, so there is no official line to contrast with.
    expect(screen.queryByTestId("hero-official")).toBeNull();
  });
  it("places the market clock in the aside slot it is handed (where the sparkline was)", () => {
    const f = { ...base.freshness!, next_open_at: "2026-11-02T14:30:00Z" } as OverviewDto["freshness"];
    const { container } = render(
      <OverviewHero
        data={{ ...base, freshness: f }}
        currency="EUR"
        loading={false}
        now={NOW}
        aside={(clock) => <div data-testid="today-block">{clock}</div>}
      />,
    );
    const clock = screen.getByTestId("market-clock");
    expect(clock).toHaveTextContent("Closed");
    expect(clock).toHaveTextContent("opens in 5 h 30 min");
    expect(container.querySelector(".overview-hero__aside [data-testid='today-block']")).toContainElement(clock);
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
  it("carries no day facts of its own, in any market state", () => {
    const shut = { ...base, last_session: { overnight_currency: "-120.5" } } as unknown as OverviewDto;
    render(<OverviewHero data={shut} currency="EUR" loading={false} now={NOW} />);
    expect(screen.queryByTestId("overnight-currency")).toBeNull();
    expect(screen.queryByTestId("last-session-est")).toBeNull();
  });

  describe("session / overnight split under the day figure", () => {
    const withSplit = (ls: Record<string, string | null>) =>
      ({ ...base, last_session: { move: "1500", ...ls } }) as unknown as OverviewDto;

    it("after the close, when the currency moved: the graph's wording under the move row", () => {
      render(
        <OverviewHero
          data={withSplit({ move_pct: "0.0081", overnight_pct: "-0.0045", overnight_currency: "-900" })}
          currency="EUR"
          loading={false}
          now={NOW}
        />,
      );
      expect(screen.getByTestId("hero-day-split")).toHaveTextContent(
        /Session\s*\+0\.81%\s*Overnight\s*-0\.45%/,
      );
      expect(screen.getByRole("button", { name: "About session and overnight" })).toBeInTheDocument();
    });

    it("is hidden while the market is open (no last_session)", () => {
      render(<OverviewHero data={base} currency="EUR" loading={false} now={NOW} />);
      expect(screen.queryByTestId("hero-day-split")).toBeNull();
    });

    it("is hidden when the currency did not move (e.g. the USD view)", () => {
      render(
        <OverviewHero
          data={withSplit({ move_pct: "0.0081", overnight_pct: "0", overnight_currency: "0" })}
          currency="USD"
          loading={false}
          now={NOW}
        />,
      );
      expect(screen.queryByTestId("hero-day-split")).toBeNull();
    });
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

  it("estimating: the headline is the estimate, chipped, in both currencies", () => {
    const { container } = render(<OverviewHero data={estimating} currency="EUR" loading={false} now={NOW} />);
    expect(container.querySelector(".overview-hero__value")).toHaveTextContent("€201,600.00");
    expect(screen.getByTestId("hero-estimate-chip")).toHaveTextContent("≈ est.");
    expect(screen.getByRole("button", { name: "About the estimated total" })).toBeInTheDocument();
    // Secondary currency follows its own estimate.
    expect(screen.getByText("US$217,728.00")).toBeInTheDocument();
    // The official book sits with the headline: the estimate only ever stands in
    // for it, so the real number belongs beside the one replacing it.
    const official = screen.getByTestId("hero-official");
    expect(official).toHaveTextContent("Official");
    expect(official).toHaveTextContent("€200,000.00");
    const change = screen.getByTestId("hero-official-change");
    expect(change).toHaveTextContent("+€1,380.00");
    expect(change).toHaveTextContent("+0.69%");
  });

  it("the change row is the estimated move, and the same row in every market state", () => {
    const { container } = render(<OverviewHero data={estimating} currency="EUR" loading={false} now={NOW} />);
    const move = container.querySelector(".overview-hero__move");
    expect(move).toHaveTextContent("+€3,100.00");
    expect(move).toHaveTextContent("+1.56%");
    // Its two halves (price move, overnight FX) are reported below, not here.
    expect(move).not.toHaveTextContent("Price move");
    expect(move).not.toHaveTextContent("Overnight");
    expect(move).not.toHaveTextContent("3,200");
  });
});
