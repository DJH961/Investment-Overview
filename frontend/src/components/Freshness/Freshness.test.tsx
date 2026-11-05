import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatTime, setFormatPrefs } from "../../lib/format";
import { IDLE_REFRESH } from "../../lib/refresh";
import {
  closeOf,
  describeFreshness,
  foldStamps,
  formatStamp,
  holdingMarks,
  Freshness,
  holdingPriceTime,
  isNavRow,
  lastSessionLabel,
  priceAsOf,
  PriceStamps,
  relativeDay,
  sentenceCase,
  zonedInstant,
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
    expect(formatStamp("2026-11-01T09:10:00Z", { ...o, weekdays: true })).toBe("Sun 09:10");
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
  it("names a close by its exact closing time in the viewer's zone (DST-aware)", () => {
    // 16:00 New York: 21:00 UTC after the US clock change (1 Nov 2026), 20:00 UTC before it.
    expect(closeOf("2026-11-02", o)).toBe("today 21:00 (close)");
    expect(closeOf("2026-10-30", o)).toBe("Fri 20:00 (close)");
    expect(closeOf("2026-10-30", { timeZone: "Europe/Berlin", now: NOW })).toBe("Fri 21:00 (close)");
    expect(closeOf("2026-10-12", o)).toBe("Mon 12 Oct (close)");
    // An exchange with no known closing bell: the day only.
    expect(closeOf("2026-10-30", { ...o, close: null })).toBe("Fri (close)");
    expect(zonedInstant("2026-07-01", 16, "America/New_York")).toBe("2026-07-01T20:00:00.000Z");
  });
  it("says what a price is: live, close or NAV", () => {
    const row = { updated_at: "2026-11-02T14:30:00Z", price_as_of: "2026-11-02", market_open: true, daily_is_stale: false };
    expect(priceAsOf(holdingPriceTime(row), o)).toBe("today 14:30 (live)");
    expect(priceAsOf(holdingPriceTime({ ...row, market_open: false }), o)).toBe("today 21:00 (close)");
    expect(priceAsOf(holdingPriceTime({ ...row, daily_is_stale: true, price_as_of: "2026-10-30" }), o)).toBe(
      "Fri 20:00 (close)",
    );
    // The provider's market time wins when it is from the same session.
    const struck = { ...row, market_open: false, price_as_of: "2026-10-30", price_market_at: "2026-10-30T20:00:02Z" };
    expect(priceAsOf(holdingPriceTime(struck), o)).toBe("Fri 20:00 (close)");
    // A time long after the bell (a NAV publish mixed into a book-wide time) is not the close.
    expect(priceAsOf({ instant: "2026-10-30T22:41:00Z", date: "2026-10-30" }, o)).toBe("Fri 20:00 (close)");
    // ... but an older market time never dates a newer close.
    expect(priceAsOf(holdingPriceTime({ ...struck, price_as_of: "2026-11-02" }), o)).toBe("today 21:00 (close)");
  });
  it("never calls a mutual fund's NAV a close", () => {
    const fund = {
      updated_at: "2026-11-02T14:30:00Z",
      price_as_of: "2026-11-01",
      market_open: true,
      daily_is_stale: false,
      asset_class: "mutual_fund",
      price_type: "market",
    };
    expect(isNavRow(fund)).toBe(true);
    // Only a date: the day + (NAV), even while the market trades.
    expect(priceAsOf(holdingPriceTime(fund), o)).toBe("yesterday (NAV)");
    expect(priceAsOf(holdingPriceTime({ ...fund, price_as_of: "2026-10-28" }), o)).toBe("Wed (NAV)");
    // The publish time when the provider gives it.
    const published = { ...fund, price_as_of: "2026-11-01", price_market_at: "2026-11-01T23:41:00Z" };
    expect(priceAsOf(holdingPriceTime(published), o)).toBe("yesterday 23:41 (NAV)");
    expect(priceAsOf(holdingPriceTime({ ...fund, price_type: "nav", asset_class: "etf" }), o)).toBe("yesterday (NAV)");
    for (const text of [priceAsOf(holdingPriceTime(fund), o), priceAsOf(holdingPriceTime(published), o)]) {
      expect(text).not.toMatch(/close/);
    }
  });
  it("capitalises a stamp that starts a line", () => {
    expect(sentenceCase("yesterday 22:00 (close)")).toBe("Yesterday 22:00 (close)");
  });
  it("labels a day move that is not today's as the last session", () => {
    expect(lastSessionLabel("2026-11-02", o)).toBeNull();
    expect(lastSessionLabel("2026-10-30", o)).toBe("Last session · Fri");
  });
});

describe("foldStamps", () => {
  const o = { timeZone: "UTC", now: NOW };
  const etf = (id: number, extra: object = {}) => ({
    id,
    updated_at: `2026-11-02T14:${10 + id}:00Z`,
    price_as_of: "2026-10-30",
    market_open: false,
    daily_is_stale: false,
    ...extra,
  });
  it("says the shared price time once and keeps only the rows that differ", () => {
    const rows = [etf(1), etf(2), etf(3, { asset_class: "mutual_fund", price_as_of: "2026-10-29" }), etf(4)];
    const f = foldStamps(rows, o);
    expect(f.price).toBe("Fri 20:00 (close)");
    expect(f.updated).toBe("2026-11-02T14:14:00Z");
    expect(f.rowPrice(rows[0])).toBeNull();
    expect(f.rowPrice(rows[1])).toBeNull();
    expect(f.rowPrice(rows[2])).toBe("Thu (NAV)");
    expect(f.rowPrice(rows[3])).toBeNull();
  });
  it("flags a stale close from an older session", () => {
    const rows = [etf(1), etf(2, { price_as_of: "2026-10-23" }), etf(3)];
    expect(foldStamps(rows, o).rowPrice(rows[1])).toBe("Fri 23 Oct (close)");
  });
  it("is empty for an empty list", () => {
    const f = foldStamps([], o);
    expect(f.price).toBeNull();
    expect(f.updated).toBeNull();
  });
});

describe("holdingMarks", () => {
  const o = { timeZone: "UTC", now: NOW };
  const row = (extra: object = {}) => ({
    price_as_of: "2026-10-30",
    daily_growth_as_of: "2026-10-30",
    market_open: false,
    daily_is_stale: false,
    is_money_market: false,
    ...extra,
  });
  it("ticks only holdings on the latest close while the market is shut", () => {
    const etf = row();
    const fundBefore = row({ asset_class: "mutual_fund", price_as_of: "2026-10-29", daily_growth_as_of: "2026-10-29", daily_is_stale: true });
    const fundAfter = row({ asset_class: "mutual_fund" });
    const cash = row({ is_money_market: true, price_as_of: null });
    const m = holdingMarks([etf, fundBefore, fundAfter, cash], o);
    expect(m.tick(etf)).toBe("Up to date with the latest close");
    expect(m.tick(fundAfter)).toBe("Up to date with the latest NAV");
    expect(m.tick(fundBefore)).toBeNull();
    expect(m.tick(cash)).toBeNull();
    // While the market trades there is no tick at all.
    expect(m.tick({ ...etf, market_open: true })).toBeNull();
  });
  it("explains a greyed day move with the session word", () => {
    const fresh = row();
    const stale = row({ daily_is_stale: true, daily_growth_as_of: "2026-10-29" });
    const m = holdingMarks([fresh, stale], o);
    expect(m.staleMove(fresh)).toBeNull();
    expect(m.staleMove(stale)).toBe("Not updated Fri — an earlier session's move");
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
      label: "Closed · prices as of Fri 20:00 (close)",
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
    expect(container).toHaveTextContent("Price as of Fri 20:00 (close)");
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
