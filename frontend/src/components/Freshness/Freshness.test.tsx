import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IDLE_REFRESH } from "../../lib/refresh";
import { describeFreshness, Freshness } from ".";
import { preMarketOpen } from "./describeFreshness";

const base = {
  market_state: "open" as const,
  prices_live: true,
  refresh_running: false,
  historical: false,
  progress_done: 0,
  progress_total: 0,
  last_price_update_at: "2026-11-02T14:32:00Z",
  price_market_at: "2026-10-30T20:00:00Z",
  price_observed_at: "2026-11-02T14:30:00Z",
};
const opts = { live: "connected" as const, refresh: IDLE_REFRESH, timeZone: "UTC" };

describe("describeFreshness", () => {
  it("says Live with the price time only when prices are live", () => {
    expect(describeFreshness(base, opts)).toEqual({ status: "live", label: "Live · 14:32" });
    expect(describeFreshness({ ...base, prices_live: false }, opts)).toEqual({
      status: "closed",
      label: "Updated 14:32",
    });
  });
  it("names the price day when the market is closed", () => {
    // Tuesday 22:00 UTC = 17:00 New York, after the close.
    const v = describeFreshness(
      { ...base, market_state: "closed", prices_live: false },
      { ...opts, now: new Date("2026-11-03T22:00:00Z") },
    );
    expect(v).toEqual({ status: "closed", label: "Closed · prices as of Fri 20:00" });
  });
  it("says when the market opens on a weekday morning", () => {
    // Tuesday 07:38 UTC = 02:38 New York; the bell is 09:30 New York = 14:30 UTC.
    const v = describeFreshness(
      { ...base, market_state: "closed", prices_live: false },
      { ...opts, now: new Date("2026-11-03T07:38:00Z") },
    );
    expect(v).toEqual({ status: "closed", label: "Pre-market · opens 14:30" });
    expect(preMarketOpen(new Date("2026-11-07T07:38:00Z"))).toBeNull(); // Saturday
    expect(preMarketOpen(new Date("2026-11-03T15:00:00Z"))).toBeNull(); // already open
    // Summer time: 09:30 EDT = 13:30 UTC.
    expect(preMarketOpen(new Date("2026-07-07T08:00:00Z"))?.toISOString()).toBe("2026-07-07T13:30:00.000Z");
  });
  it("shows Updating… and history progress", () => {
    expect(describeFreshness({ ...base, refresh_running: true }, opts).label).toBe("Updating…");
    const hist = { ...IDLE_REFRESH, running: true, historical: true, done: 3, total: 10 };
    expect(describeFreshness(base, { ...opts, refresh: hist })).toEqual({
      status: "updating",
      label: "Downloading history 3/10",
    });
  });
  it("shows Reconnecting… when the stream dropped", () => {
    expect(describeFreshness(base, { ...opts, live: "reconnecting" })).toEqual({
      status: "stale",
      label: "Reconnecting…",
    });
  });
  it("prefers a newer tick time and tick live flag", () => {
    const refresh = { ...IDLE_REFRESH, lastUpdateAt: "2026-11-02T14:40:00Z", pricesLive: false };
    expect(describeFreshness(base, { ...opts, refresh }).label).toBe("Updated 14:40");
  });
});

describe("Freshness", () => {
  it("renders the status modifier and label", () => {
    const { container } = render(<Freshness status="updating" label="Updating…" />);
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("freshness--updating");
  });
});
