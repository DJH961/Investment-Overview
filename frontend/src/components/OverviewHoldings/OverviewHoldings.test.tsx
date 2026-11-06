import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setHideAmounts } from "../../lib/format";
import type { HoldingRowDto, OverviewDto } from "../../lib/queries/portfolio";
import { DisplayPrefsProvider } from "../../lib/displayPrefs";

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
  const movers = { winners: [{ symbol: "S9" }], losers: [] } as unknown as OverviewDto["movers"];
  const SET_ON = { value: true, source: "db", default: false, env_value_present: false, modified_at: null, is_set: true, stored_invalid: false };

  it("lists the largest positions with pills and a full-table link", () => {
    const { container } = render(
      <MemoryRouter>
        <OverviewHoldings currency="EUR" movers={movers} />
      </MemoryRouter>,
    );
    const symbols = [...container.querySelectorAll(".overview-holdings__row")].map((n) => n.getAttribute("data-symbol"));
    expect(symbols).toEqual(["S20", "S9", "S8", "S7", "S6", "S5", "S4", "S3"]);
    expect(screen.getByText("CASH")).toBeInTheDocument();
    expect(screen.getByText("bad history")).toBeInTheDocument();
    // `display.mover_badges` defaults off: the pill wrapped the symbol line too
    // often, and the Top movers card above already names them.
    expect(screen.queryByText("top winner")).toBeNull();
    expect(screen.queryByText("top loser")).toBeNull();
    expect(container.querySelector('[data-symbol="S20"] .overview-holdings__today--stale')).not.toBeNull();
    // A greyed move says why (never colour alone).
    expect(container.querySelector('[data-symbol="S20"] .overview-holdings__today--stale')).toHaveTextContent(
      /an earlier session's move/,
    );
    expect(screen.getByRole("link", { name: "Full table" })).toHaveAttribute("href", "/holdings");
    expect(screen.getByRole("button", { name: "Show all 10 holdings" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Holdings" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the mover badges once display.mover_badges is turned on", () => {
    render(
      <DisplayPrefsProvider values={{ "display.mover_badges": SET_ON } as never}>
        <MemoryRouter>
          <OverviewHoldings currency="EUR" movers={movers} />
        </MemoryRouter>
      </DisplayPrefsProvider>,
    );
    expect(screen.getByText("top winner")).toBeInTheDocument();
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

  describe("twin sub-row", () => {
    const pending = {
      symbol: "VOO",
      tier: "same_index",
      est_price: "500",
      est_value: "41270",
      est_today_move: "250",
      est_today_pct: "0.0061",
      est_total_return: "9370",
      est_total_growth: "0.2934",
      at: "2026-11-02T14:02:00Z",
      at_close: true,
      pending: true,
      divergence: null,
    };
    const posted = {
      symbol: "VOO",
      tier: "same_index",
      pending: false,
      divergence: { last_pp: "0.03", last_money: "12", median_abs_pp: "0.02", bias_pp: "0.01", sessions: 20, window: 20 },
    };
    function withRows(rows: HoldingRowDto[], body: () => void) {
      const saved = holdings.splice(0, holdings.length, ...rows);
      try {
        body();
      } finally {
        holdings.splice(0, holdings.length, ...saved);
      }
    }
    const view = () =>
      render(
        <MemoryRouter>
          <OverviewHoldings currency="EUR" />
        </MemoryRouter>,
      );

    it("renders one estimate line under a pending fund, subordinate and labelled", () => {
      withRows([row(1, { symbol: "FXAIX", twin: pending as HoldingRowDto["twin"] }), row(2)], () => {
        const { container } = view();
        const line = screen.getByLabelText("Estimate for FXAIX from VOO");
        expect(line).toHaveAttribute("data-twin-for", "FXAIX");
        expect(line).toHaveTextContent("≈ est.");
        expect(line).toHaveTextContent("VOO");
        expect(line).toHaveTextContent("≈€41,270.00");
        expect(line).toHaveTextContent("≈+0.61%");
        expect(line).toHaveTextContent("≈+€250.00");
        // Every other row reports a gain since buying in money and percent; so does this one.
        expect(line).toHaveTextContent("≈+€9,370.00");
        expect(line).toHaveTextContent("≈+29.34%");
        // The twin's own close is in hand, so the estimate is final until the next open.
        expect(line.querySelector(".overview-holdings__twin-tick")).not.toBeNull();
        // Sits right after its row; still no weight bar (that belongs to the holding).
        const items = [...container.querySelectorAll(".overview-holdings__list > li")];
        expect(items[items.indexOf(line) - 1]).toHaveAttribute("data-symbol", "FXAIX");
        expect(line.querySelector(".overview-holdings__weight")).toBeNull();
        expect(container.querySelectorAll(".overview-holdings__row")).toHaveLength(2);
      });
    });

    it("after the NAV posts it only says how far off the twin was", () => {
      withRows([row(1, { symbol: "FXAIX", twin: posted as HoldingRowDto["twin"] })], () => {
        view();
        const line = screen.getByLabelText("VOO twin accuracy for FXAIX");
        expect(line).toHaveTextContent("twin was +0.03 pp off (+€12)");
        expect(screen.queryByText("≈ est.")).toBeNull();
      });
    });

    it("shows no line without a twin or a usable figure", () => {
      withRows(
        [row(1), row(2, { twin: { ...posted, divergence: null } as HoldingRowDto["twin"] })],
        () => {
          const { container } = view();
          expect(container.querySelector(".overview-holdings__twin")).toBeNull();
        },
      );
    });

    it("hide-amounts masks the money and keeps the percent", () => {
      setHideAmounts(true);
      try {
        withRows([row(1, { symbol: "FXAIX", twin: pending as HoldingRowDto["twin"] })], () => {
          view();
          const line = screen.getByLabelText("Estimate for FXAIX from VOO");
          expect(line).not.toHaveTextContent("41,270");
          expect(line).toHaveTextContent("•");
          expect(line).toHaveTextContent("≈+0.61%");
        });
      } finally {
        setHideAmounts(false);
      }
    });
  });
});
