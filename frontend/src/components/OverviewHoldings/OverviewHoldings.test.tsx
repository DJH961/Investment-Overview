import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HoldingRowDto, OverviewDto } from "../../lib/queries/portfolio";

const row = (i: number, extra: Partial<HoldingRowDto> = {}) =>
  ({
    instrument_id: i,
    symbol: `S${i}`,
    name: `Name ${i}`,
    value: String(i * 1000),
    today_pct: "0.01",
    today_move: "10",
    daily_is_stale: false,
    market_open: true,
    is_money_market: false,
    value_warning: false,
    price_data_warning: false,
    updated_at: "2026-11-02T14:30:00Z",
    ...extra,
  }) as HoldingRowDto;

const holdings = [
  ...Array.from({ length: 9 }, (_, i) => row(i + 1)),
  row(20, { is_money_market: true, daily_is_stale: true, price_data_warning: true }),
];

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useHoldings: () => ({ data: { holdings }, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

import { OverviewHoldings } from "./OverviewHoldings";

afterEach(() => localStorage.clear());

describe("OverviewHoldings", () => {
  it("lists the largest positions with pills, mover badges and a full-table link", () => {
    const movers = { winners: [{ symbol: "S9" }], losers: [] } as unknown as OverviewDto["movers"];
    const { container } = render(
      <MemoryRouter>
        <OverviewHoldings currency="EUR" movers={movers} />
      </MemoryRouter>,
    );
    const symbols = [...container.querySelectorAll(".overview-holdings__row")].map((n) => n.getAttribute("data-symbol"));
    expect(symbols).toEqual(["S20", "S9", "S8", "S7", "S6", "S5", "S4", "S3"]);
    expect(screen.getByText("CASH")).toBeInTheDocument();
    expect(screen.getByText("bad history")).toBeInTheDocument();
    expect(screen.getByText("top winner")).toBeInTheDocument();
    expect(container.querySelector('[data-symbol="S20"] .overview-holdings__today--stale')).not.toBeNull();
    // A greyed move says why (never colour alone).
    expect(container.querySelector('[data-symbol="S20"] .overview-holdings__today--stale')).toHaveTextContent(
      /an earlier session's move/,
    );
    expect(screen.getByRole("link", { name: "Full table" })).toHaveAttribute("href", "/holdings");
    expect(screen.getByRole("button", { name: "Show all 10 holdings" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Holdings" })).toHaveAttribute("aria-expanded", "true");
  });

  it("folds the rest inline in the same list and remembers the choice", () => {
    const symbols = (c: HTMLElement) =>
      [...c.querySelectorAll(".overview-holdings__list .overview-holdings__row")].map((n) => n.getAttribute("data-symbol"));
    const first = render(
      <MemoryRouter>
        <OverviewHoldings currency="EUR" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 holdings" }));
    expect(symbols(first.container)).toEqual(["S20", "S9", "S8", "S7", "S6", "S5", "S4", "S3", "S2", "S1"]);
    expect(localStorage.getItem("iv.overview.holdings.open")).toBe("true");
    first.unmount();
    // Reopened: still unfolded, and it folds back to the top 8.
    const again = render(
      <MemoryRouter>
        <OverviewHoldings currency="EUR" />
      </MemoryRouter>,
    );
    expect(symbols(again.container)).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(symbols(again.container)).toHaveLength(8);
    expect(localStorage.getItem("iv.overview.holdings.open")).toBe("false");
  });

  it("marks NAV funds and ticks holdings already on the latest close while the market is shut", () => {
    const saved = holdings.splice(0, holdings.length);
    holdings.push(
      row(1, { market_open: false, price_as_of: "2026-10-30" }),
      row(2, { market_open: false, price_as_of: "2026-10-30", asset_class: "mutual_fund", price_type: "nav" }),
      row(3, { market_open: false, price_as_of: "2026-10-29", asset_class: "mutual_fund", daily_is_stale: true }),
    );
    try {
      const { container } = render(
        <MemoryRouter>
          <OverviewHoldings currency="EUR" />
        </MemoryRouter>,
      );
      expect(screen.getAllByText("NAV")).toHaveLength(2);
      expect(container.querySelector('[data-symbol="S1"] .price-tick')).toHaveAttribute("data-tick", "Up to date with the latest close");
      expect(container.querySelector('[data-symbol="S2"] .price-tick')).toHaveAttribute("data-tick", "Up to date with the latest NAV");
      expect(container.querySelector('[data-symbol="S3"] .price-tick')).toBeNull();
    } finally {
      holdings.splice(0, holdings.length, ...saved);
    }
  });
});
