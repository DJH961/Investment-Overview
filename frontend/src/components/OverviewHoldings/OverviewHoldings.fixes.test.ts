import { describe, expect, it } from "vitest";
import type { HoldingRowDto } from "../../lib/queries/portfolio";
import { hasTwinLine, TWIN_SEEN_BEFORE_NAV_MS, type TwinWatchState } from "./OverviewHoldings";

const NOW = Date.parse("2026-11-10T12:00:00Z");

const row = (updatedAt: string) =>
  ({
    instrument_id: 1,
    symbol: "FAKE1",
    price_as_of: "2026-11-10",
    updated_at: updatedAt,
    twin: {
      symbol: "FAKE2",
      pending: false,
      divergence: { last_pp: "0.03", last_money: "12", last_date: "2026-11-10" },
    },
  }) as unknown as HoldingRowDto;

const watch = (seenMs: number): TwinWatchState => ({ seenPending: { FAKE1: String(seenMs) }, dismissed: {} });

describe("twin accuracy note: only for a pending estimate seen this session", () => {
  const navAt = new Date(NOW - 2 * 3600 * 1000).toISOString();

  it("shows when the estimate was seen shortly before the NAV posted", () => {
    expect(hasTwinLine(row(navAt), watch(NOW - 5 * 3600 * 1000), NOW)).toBe(true);
  });

  it("hides when the only sighting is from a previous day", () => {
    const seen = Date.parse(navAt) - TWIN_SEEN_BEFORE_NAV_MS - 3600 * 1000;
    expect(hasTwinLine(row(navAt), watch(seen), NOW)).toBe(false);
  });

  it("hides when the estimate was never seen (or an old non-numeric stamp is stored)", () => {
    expect(hasTwinLine(row(navAt), { seenPending: {}, dismissed: {} }, NOW)).toBe(false);
    expect(hasTwinLine(row(navAt), { seenPending: { FAKE1: "2026-11-02T14:02:00Z" }, dismissed: {} }, NOW)).toBe(false);
  });
});
