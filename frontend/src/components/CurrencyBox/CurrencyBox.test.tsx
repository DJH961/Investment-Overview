import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewDto } from "../../lib/queries/portfolio";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

import { CurrencyBox, sincePhrase } from "./CurrencyBox";

const regime = {
  forex_frozen: false,
  forex_open: true,
  holiday: false,
  market_open: true,
  session_view: true,
  single_overnight: false,
  weekend_overnight: false,
};

function overview(ccy: "EUR" | "USD", today: Record<string, unknown>): OverviewDto {
  return {
    ccy,
    currency: {
      lifetime: {},
      return_split: {},
      today: {
        anchor_missing: false,
        regime,
        pair: ccy === "EUR" ? "USD/EUR" : "EUR/USD",
        spot: "1.0800",
        spot_display: ccy === "EUR" ? "0.9259" : "1.0800",
        as_of: { as_of: "2026-11-02", source: "live", observed_at: "2026-11-02T14:31:00Z" },
        move: { pct: "0.0025", anchor_kind: "prev_close", label_kind: "today", session_date: "2026-11-02" },
        since: { pct: "-0.001", kind: "open" },
        since_phrase: { kind: "since_yesterday", session_date: "2026-10-30" },
        effect_eur: { net: "-120", market_hours: "-150", overnight: "30" },
        investing_power_usd: { amount_eur: "500", amount_usd: "540", net: "1.25", market_hours: "1", overnight: "0.25" },
        ...today,
      },
    },
  } as unknown as OverviewDto;
}

afterEach(() => localStorage.clear());

describe("CurrencyBox", () => {
  it("open market (EUR): rate, live stamp, today and since-open, live leg first", () => {
    const { container } = render(<CurrencyBox data={overview("EUR", {})} />);
    expect(screen.getByRole("button", { name: "Currency · EUR ↔ USD" })).toBeInTheDocument();
    expect(screen.getByText("USD/EUR")).toBeInTheDocument();
    expect(screen.getByText("0.9259")).toBeInTheDocument();
    expect(screen.getByText(/as of 14:31/)).toBeInTheDocument();
    expect(screen.getByText("Live · 14:31")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("since last close")).toBeInTheDocument();
    expect(screen.getByText("Since open")).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "Currency effect since yesterday" });
    expect(within(panel).getAllByText("-€120")[0]).toBeInTheDocument();
    expect(within(panel).queryByText(/Regular/)).toBeNull();
    const rows = [...container.querySelectorAll(".diverging-bar__row")].map((r) => r.getAttribute("data-row"));
    expect(rows).toEqual(["market", "overnight"]);
    expect(container.querySelector('[data-row="market"]')).toHaveTextContent("live");
    expect(container.querySelector('[data-row="overnight"]')).toHaveTextContent("last");
    expect(screen.queryByText("Market closed")).toBeNull();
  });

  it("frozen weekend: Market closed, reopen time, weekday label, paused overnight leg first", () => {
    const { container } = render(
      <CurrencyBox
        data={overview("EUR", {
          regime: { ...regime, market_open: false, forex_open: false, forex_frozen: true },
          reopen_at: "2026-11-01T22:00:00Z",
          as_of: { as_of: "2026-10-30", source: "eod", observed_at: null },
          move: { pct: "0.001", anchor_kind: "session_open", label_kind: "weekday", session_date: "2026-10-30" },
          since: { pct: "0.0005", kind: "close" },
          since_phrase: { kind: "on_day", session_date: "2026-10-30" },
        })}
      />,
    );
    expect(screen.getByText("Market closed")).toBeInTheDocument();
    expect(screen.getByText(/Frozen at Friday's close · reopens Sun 22:00/)).toBeInTheDocument();
    expect(screen.getByText("Friday")).toBeInTheDocument();
    expect(screen.getByText("since last open")).toBeInTheDocument();
    expect(screen.getByText("Since close")).toBeInTheDocument();
    expect(screen.getByText("EOD FX")).toBeInTheDocument();
    expect(screen.getByText("as of 30/10, 15:00")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Currency effect on Friday" })).toBeInTheDocument();
    expect(container.querySelector(".diverging-bar__row")).toHaveAttribute("data-row", "overnight");
    expect(container.querySelector('[data-row="overnight"]')).toHaveTextContent("paused");
  });

  it("frozen weekend with live/backfilled Friday close: Market closed without EOD FX, weekday time", () => {
    render(
      <CurrencyBox
        data={overview("EUR", {
          regime: { ...regime, market_open: false, forex_open: false, forex_frozen: true },
          reopen_at: "2026-11-01T22:00:00Z",
          as_of: { as_of: "2026-10-30", source: "live", observed_at: "2026-10-30T21:00:00Z" },
          spot_observed_at: "2026-10-30T21:00:00Z",
          move: { pct: "0.001", anchor_kind: "session_open", label_kind: "weekday", session_date: "2026-10-30" },
          since: { pct: "0.0005", kind: "close" },
          since_phrase: { kind: "on_day", session_date: "2026-10-30" },
        })}
      />,
    );
    expect(screen.getByText("Market closed")).toBeInTheDocument();
    expect(screen.queryByText("EOD FX")).toBeNull();
    expect(screen.getByText("as of Fri 21:00")).toBeInTheDocument();
  });

  it("US holiday: single Market holiday bar and no since stat", () => {
    const { container } = render(
      <CurrencyBox
        data={overview("EUR", {
          regime: { ...regime, market_open: false, holiday: true, single_overnight: true, session_view: false },
          move: { pct: "0.002", anchor_kind: "overnight", label_kind: "today", session_date: "2026-11-02" },
          since: null,
        })}
      />,
    );
    expect(screen.getByText("overnight")).toBeInTheDocument();
    expect(screen.queryByText(/Since/)).toBeNull();
    expect(container.querySelectorAll(".diverging-bar__row")).toHaveLength(1);
    expect(screen.getByText("Market holiday")).toBeInTheDocument();
  });

  it("USD display: investing power with cents and the regular amount", () => {
    render(<CurrencyBox data={overview("USD", {})} />);
    expect(screen.getByText("EUR/USD")).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "Investing power since yesterday" });
    expect(within(panel).getAllByText("+US$1.25").length).toBeGreaterThan(0);
    expect(within(panel).getByText("€500")).toBeInTheDocument();
    expect(within(panel).getByText("US$540.00")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Currency effect/ })).toBeNull();
  });

  it("phrases", () => {
    expect(sincePhrase({ kind: "since_day", session_date: "2026-10-30" })).toBe("since Friday");
    expect(sincePhrase({ kind: "yesterday", session_date: "2026-10-30" })).toBe("yesterday");
    expect(sincePhrase(null)).toBe("since yesterday");
  });
});

describe("ecbFixingInstant", () => {
  it("is 16:00 Berlin time: 15:00 UTC in winter, 14:00 UTC in summer", async () => {
    const { ecbFixingInstant } = await import("./CurrencyBox");
    expect(ecbFixingInstant("2026-01-15")).toBe("2026-01-15T15:00:00Z");
    expect(ecbFixingInstant("2026-07-05")).toBe("2026-07-05T14:00:00Z");
    expect(ecbFixingInstant("2026-03-27")).toBe("2026-03-27T15:00:00Z");
    expect(ecbFixingInstant("2026-10-23")).toBe("2026-10-23T14:00:00Z");
  });
});
