import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatTime, setFormatPrefs } from "../../lib/format";
import { IDLE_REFRESH } from "../../lib/refresh";
import {
  closeOf,
  describeFreshness,
  formatStamp,
  Freshness,
  holdingPriceTime,
  lastSessionLabel,
  priceAsOf,
  PriceStamps,
  relativeDay,
} from ".";

// Monday 2 Nov 2026, 15:00 UTC.
const NOW = new Date("2026-11-02T15:00:00Z");
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
const opts = { live: "connected" as const, refresh: IDLE_REFRESH, timeZone: "UTC", now: NOW };

afterEach(() => setFormatPrefs({ locale: "en-GB", timeZone: undefined, hour12: undefined }));

describe("stamps", () => {
  const o = { timeZone: "UTC", now: NOW };
  it("summarises instants relative to today", () => {
    expect(formatStamp("2026-11-02T13:42:00Z", o)).toBe("today 13:42");
    expect(formatStamp("2026-11-01T09:10:00Z", o)).toBe("yesterday 09:10");
    expect(formatStamp("2026-10-29T22:00:00Z", o)).toBe("Thu 22:00");
    expect(formatStamp("2026-10-12T22:00:00Z", o)).toBe("Mon 12 Oct");
    expect(formatStamp("2025-10-13T22:00:00Z", o)).toBe("Mon, 13 Oct 2025");
  });
  it("summarises calendar dates without a clock", () => {
    expect(formatStamp("2026-11-02", o)).toBe("today");
    expect(formatStamp("2026-11-01", o)).toBe("yesterday");
    expect(formatStamp("2026-10-30", o)).toBe("Fri 30 Oct");
    expect(relativeDay("2026-10-30", o)).toBe("Fri");
  });
  it("reads offset-less server times as UTC, in the Settings timezone", () => {
    expect(formatTime("2026-11-02T13:42:00")).toBe(formatTime("2026-11-02T13:42:00Z"));
    expect(formatStamp("2026-11-02T13:42:00", { timeZone: "Europe/Berlin", now: NOW })).toBe("today 14:42");
    // The viewer's day decides "today" / "yesterday": 23:30 UTC is already tomorrow in Berlin.
    expect(formatStamp("2026-11-01T23:30:00Z", { timeZone: "Europe/Berlin", now: NOW })).toBe("today 00:30");
  });
  it("follows the 12-hour clock setting", () => {
    setFormatPrefs({ hour12: true });
    expect(formatStamp("2026-11-02T13:42:00Z", o)).toBe("today 1:42 PM");
  });
  it("names a settled price by its close, a live one by its time", () => {
    expect(closeOf("2026-11-02", o)).toBe("today's close");
    expect(closeOf("2026-11-01", o)).toBe("yesterday's close");
    expect(closeOf("2026-10-30", o)).toBe("Fri 30 Oct close");
    const row = { updated_at: "2026-11-02T14:30:00Z", price_as_of: "2026-11-02", market_open: true, daily_is_stale: false };
    expect(priceAsOf(holdingPriceTime(row), o)).toBe("today 14:30");
    expect(priceAsOf(holdingPriceTime({ ...row, market_open: false }), o)).toBe("today's close");
    expect(priceAsOf(holdingPriceTime({ ...row, daily_is_stale: true, price_as_of: "2026-10-30" }), o)).toBe(
      "Fri 30 Oct close",
    );
  });
  it("labels a day move that is not today's as the last session", () => {
    expect(lastSessionLabel("2026-11-02", o)).toBeNull();
    expect(lastSessionLabel("2026-10-30", o)).toBe("Last session · Fri");
  });
});

describe("describeFreshness", () => {
  it("says Live with the price time only when prices are live", () => {
    expect(describeFreshness(base, opts)).toEqual({ status: "live", label: "Live · today 14:32", updated: undefined });
    expect(describeFreshness({ ...base, prices_live: false }, opts)).toEqual({
      status: "closed",
      label: "Market open · prices as of today 14:30",
      short: "Open · today 14:30",
      updated: "Updated today 14:32",
    });
  });
  it("names the close the prices belong to when the market is closed", () => {
    const v = describeFreshness({ ...base, market_state: "closed", prices_live: false }, { ...opts, sessionDate: "2026-10-30" });
    expect(v).toEqual({
      status: "closed",
      label: "Closed · prices as of Fri 30 Oct close",
      short: "Closed · Fri",
      updated: "Updated today 14:32",
    });
    const noDate = describeFreshness({ ...base, market_state: "closed", prices_live: false }, opts);
    expect(noDate.label).toBe("Closed · prices as of Fri 20:00");
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
    expect(describeFreshness(base, { ...opts, refresh }).updated).toBe("Updated today 14:40");
  });
});

describe("Freshness", () => {
  it("renders the status modifier and label", () => {
    const { container } = render(<Freshness status="updating" label="Updating…" />);
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("freshness--updating");
  });
});

describe("PriceStamps", () => {
  it("labels both moments and says a shared moment once", () => {
    const o = { timeZone: "UTC", now: NOW };
    const { container, rerender } = render(
      <PriceStamps price={{ date: "2026-10-30" }} updated="2026-11-02T14:32:00Z" options={o} />,
    );
    expect(container).toHaveTextContent("Price as of Fri 30 Oct close");
    expect(container).toHaveTextContent("Updated today 14:32");
    rerender(
      <PriceStamps
        price={{ instant: "2026-11-02T14:32:00Z", marketOpen: true }}
        updated="2026-11-02T14:32:00Z"
        options={o}
      />,
    );
    expect(container.querySelectorAll(".price-stamps__item")).toHaveLength(1);
  });
});
