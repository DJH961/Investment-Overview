import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { HoldingIdentity, HoldingPills } from "./HoldingIdentity";

const row = (over: Partial<HoldingRowDto> = {}): HoldingRowDto =>
  ({
    instrument_id: 7,
    symbol: "FXAIX",
    name: "A Very Long Index Fund Name",
    account: "A",
    asset_class: "etf",
    category: "Equity",
    native_currency: "USD",
    price_type: "market",
    is_money_market: false,
    market_open: false,
    daily_is_stale: false,
    value_warning: false,
    price_data_warning: false,
    shares: "1",
    ...over,
  }) as HoldingRowDto;

const pills = (ui: React.ReactElement) => {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  return [...container.querySelectorAll(".holding-identity__pill")].map((p) => p.textContent);
};

describe("HoldingIdentity", () => {
  it("one pill set: warnings first, then live, CASH / NAV, the estimate and the mover badge", () => {
    expect(
      pills(
        <HoldingPills
          row={row({
            value_warning: true,
            price_data_warning: true,
            price_type: "nav",
            asset_class: "mutual_fund",
            twin: { symbol: "VOO", tier: "manual", pending: true, at_close: false },
          })}
          live
          badge="winner"
        />,
      ),
    ).toEqual(["stale value", "bad history", "live", "NAV", "≈ est.", "top winner"]);
  });

  it("CASH replaces NAV for a money-market fund; the estimate can be switched off", () => {
    expect(pills(<HoldingPills row={row({ is_money_market: true, price_type: "nav" })} />)).toEqual(["CASH"]);
    expect(
      pills(<HoldingPills row={row({ twin: { symbol: "VOO", tier: "manual", pending: true, at_close: false } })} est={false} />),
    ).toEqual([]);
    expect(pills(<HoldingPills row={row()} badge="loser" />)).toEqual(["top loser"]);
  });

  it("links the symbol, keeps the full name in a title, adds the twin line while pending", () => {
    render(
      <MemoryRouter>
        <HoldingIdentity
          row={row({ twin: { symbol: "VOO", tier: "manual", pending: true, at_close: false, est_today_pct: "0.0042" } })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Open FXAIX" })).toHaveAttribute("href", "/holdings/7");
    expect(screen.getByText("A Very Long Index Fund Name")).toHaveAttribute("title", "A Very Long Index Fund Name");
    expect(screen.getByText(/≈ VOO/)).toHaveTextContent(/≈ VOO\s*\+0\.42%/);
  });

  it("is plain text inside the phone row's button", () => {
    render(
      <MemoryRouter>
        <HoldingIdentity row={row()} link={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("FXAIX")).toBeInTheDocument();
  });
});
