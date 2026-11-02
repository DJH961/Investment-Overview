import { render, screen } from "@testing-library/react";
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
    expect(screen.getByText("PAR")).toBeInTheDocument();
    expect(screen.getByText("bad history")).toBeInTheDocument();
    expect(screen.getByText("top winner")).toBeInTheDocument();
    expect(container.querySelector('[data-symbol="S20"] .overview-holdings__today--stale')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Full table" })).toHaveAttribute("href", "/holdings");
    expect(screen.getByText(/2 more in the/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Holdings" })).toHaveAttribute("aria-expanded", "true");
  });
});
