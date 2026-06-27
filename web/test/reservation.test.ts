/**
 * Tests for the single reservation authority (`reservation.ts`, audit Rec 4):
 * the one atomic read-and-debit gate every metered provider request passes
 * through. Pure over an injected clock + in-memory storage — no network, no DOM.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  available,
  ledgerReservation,
  tiingoAvailable,
  twelveDataAvailable,
  twelveDataBudgetView,
  twelveDataMinuteReadyDelayMs,
} from "../src/reservation";
import { recordCredits, recordTiingoCredits, startOfHour, type StorageLike } from "../src/cache";
import { recordTiingo429, recordTwelveData429 } from "../src/provider-breaker";
import { WEB_HOURLY_CAP } from "../src/tiingo-gate";
import { FREE_TIER } from "../src/quotes";

/** A minimal in-memory localStorage stand-in shared by all the ledgers. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const NOW = 1_700_000_000_000;

describe("reservation — live availability", () => {
  let store: StorageLike;
  beforeEach(() => {
    store = memoryStorage();
  });

  it("starts at the full per-minute / hourly budgets on an empty ledger", () => {
    expect(twelveDataAvailable(NOW, store)).toBe(FREE_TIER.creditsPerMinute);
    expect(tiingoAvailable(NOW, store)).toBe(WEB_HOURLY_CAP);
    expect(available("twelvedata", NOW, store)).toBe(FREE_TIER.creditsPerMinute);
    expect(available("tiingo", NOW, store)).toBe(WEB_HOURLY_CAP);
  });

  it("reflects prior spend on each provider's own ledger", () => {
    recordCredits(3, NOW, store);
    recordTiingoCredits(10, NOW, store);
    expect(twelveDataAvailable(NOW, store)).toBe(FREE_TIER.creditsPerMinute - 3);
    expect(tiingoAvailable(NOW, store)).toBe(WEB_HOURLY_CAP - 10);
  });

  it("reads 0 for a provider while its 429 breaker is frozen", () => {
    recordTwelveData429(NOW, store);
    expect(twelveDataAvailable(NOW, store)).toBe(0);
    // Tiingo is untouched by a Twelve Data freeze.
    expect(tiingoAvailable(NOW, store)).toBe(WEB_HOURLY_CAP);

    recordTiingo429(NOW, store);
    expect(tiingoAvailable(NOW, store)).toBe(0);
  });
});

describe("reservation — atomic reserve / release", () => {
  let store: StorageLike;
  beforeEach(() => {
    store = memoryStorage();
  });

  it("grants min(requested, available) and debits the grant up-front", () => {
    const res = ledgerReservation(store);
    expect(res.reserve("twelvedata", 5, NOW)).toBe(5);
    // The debit is immediate, so a concurrent leg sees the reduced budget.
    expect(twelveDataAvailable(NOW, store)).toBe(FREE_TIER.creditsPerMinute - 5);
    // A second reserve only gets what is left (8 - 5 = 3), never the full budget.
    expect(res.reserve("twelvedata", 5, NOW)).toBe(3);
    expect(twelveDataAvailable(NOW, store)).toBe(0);
    expect(res.reserve("twelvedata", 1, NOW)).toBe(0);
  });

  it("caps an over-budget request at the live remaining credits", () => {
    const res = ledgerReservation(store);
    expect(res.reserve("twelvedata", 100, NOW)).toBe(FREE_TIER.creditsPerMinute);
    expect(res.reserve("tiingo", 100, NOW)).toBe(WEB_HOURLY_CAP);
  });

  it("grants 0 while a provider is frozen, regardless of ledger headroom", () => {
    const res = ledgerReservation(store);
    recordTwelveData429(NOW, store);
    expect(res.reserve("twelvedata", 4, NOW)).toBe(0);
    recordTiingo429(NOW, store);
    expect(res.reserve("tiingo", 4, NOW)).toBe(0);
  });

  it("release returns unbilled credits so a later request can reuse them", () => {
    const res = ledgerReservation(store);
    expect(res.reserve("twelvedata", 8, NOW)).toBe(8);
    expect(twelveDataAvailable(NOW, store)).toBe(0);
    res.release("twelvedata", 3, NOW);
    expect(twelveDataAvailable(NOW, store)).toBe(3);
    expect(res.reserve("twelvedata", 3, NOW)).toBe(3);
  });

  it("ignores non-positive requests and releases", () => {
    const res = ledgerReservation(store);
    expect(res.reserve("tiingo", 0, NOW)).toBe(0);
    expect(res.reserve("tiingo", -2, NOW)).toBe(0);
    res.release("tiingo", 0, NOW);
    expect(tiingoAvailable(NOW, store)).toBe(WEB_HOURLY_CAP);
  });

  it("never grants more than the cap after an over-release (no phantom headroom)", () => {
    const res = ledgerReservation(store);
    expect(res.reserve("tiingo", 5, NOW)).toBe(5);
    // A buggy caller releases more than it reserved; the refund is clamped so the
    // budget recovers to — but never beyond — the full cap.
    res.release("tiingo", 50, NOW);
    expect(tiingoAvailable(NOW, store)).toBe(WEB_HOURLY_CAP);
    expect(res.reserve("tiingo", 1000, NOW)).toBe(WEB_HOURLY_CAP);
  });

  it("resets the Tiingo hourly budget on the clock hour, not a trailing window", () => {
    const HOUR_MS = 60 * 60 * 1000;
    // Spend late in one clock hour, then read just past the top of the next hour.
    const lateInHour = startOfHour(NOW) + 55 * 60 * 1000;
    const earlyNextHour = startOfHour(NOW) + HOUR_MS + 60 * 1000;
    recordTiingoCredits(WEB_HOURLY_CAP, lateInHour, store);
    expect(tiingoAvailable(lateInHour, store)).toBe(0);
    // A trailing-60-min window would still suppress the new hour; the clock-hour
    // reset gives a fresh allowance at the top of the hour.
    expect(tiingoAvailable(earlyNextHour, store)).toBe(WEB_HOURLY_CAP);
  });

  it("handles a refund straddling the clock-hour boundary without inflating the cap", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const lateInHour = startOfHour(NOW) + 58 * 60 * 1000;
    const earlyNextHour = startOfHour(NOW) + HOUR_MS + 60 * 1000;
    const res = ledgerReservation(store);
    // Charge in one hour; the request throws and is refunded in the next hour.
    recordTiingoCredits(5, lateInHour, store);
    res.release("tiingo", 5, earlyNextHour);
    // The lone refund lands in the fresh hour as a negative spend, but the budget
    // is clamped so the new hour still reads exactly the full cap — never more.
    expect(tiingoAvailable(earlyNextHour, store)).toBe(WEB_HOURLY_CAP);
  });
});

describe("twelveDataBudgetView — minute/day split", () => {
  let store: StorageLike;
  beforeEach(() => {
    store = memoryStorage();
  });

  it("reads the full minute and day caps on an empty ledger", () => {
    expect(twelveDataBudgetView(NOW, store)).toEqual({
      minuteRemaining: FREE_TIER.creditsPerMinute,
      dayRemaining: FREE_TIER.creditsPerDay,
    });
  });

  it("reflects spend on both windows", () => {
    recordCredits(3, NOW, store);
    expect(twelveDataBudgetView(NOW, store)).toEqual({
      minuteRemaining: FREE_TIER.creditsPerMinute - 3,
      dayRemaining: FREE_TIER.creditsPerDay - 3,
    });
  });

  it("zeroes the minute while frozen but keeps the day count", () => {
    recordCredits(2, NOW, store);
    recordTwelveData429(NOW, store);
    const view = twelveDataBudgetView(NOW, store);
    expect(view.minuteRemaining).toBe(0);
    expect(view.dayRemaining).toBe(FREE_TIER.creditsPerDay - 2);
  });
});

describe("twelveDataMinuteReadyDelayMs — wait for a fresh minute window", () => {
  const MINUTE_MS = 60 * 1000;
  let store: StorageLike;
  beforeEach(() => {
    store = memoryStorage();
  });

  it("is 0 when the minute pool is already clear", () => {
    expect(twelveDataMinuteReadyDelayMs(NOW, store)).toBe(0);
  });

  it("waits until the last spend ages out of the rolling 60s window", () => {
    recordCredits(8, NOW, store);
    // Right after spending the whole minute, must wait a full minute.
    expect(twelveDataMinuteReadyDelayMs(NOW, store)).toBe(MINUTE_MS);
    // Halfway through, only the remainder is left to wait.
    expect(twelveDataMinuteReadyDelayMs(NOW + 20_000, store)).toBe(MINUTE_MS - 20_000);
    // Once a full minute has elapsed, the window is clear again.
    expect(twelveDataMinuteReadyDelayMs(NOW + MINUTE_MS, store)).toBe(0);
  });

  it("waits for the most recent spend when several are in the window", () => {
    recordCredits(2, NOW, store);
    recordCredits(2, NOW + 10_000, store);
    // The window clears a full minute after the *latest* spend.
    expect(twelveDataMinuteReadyDelayMs(NOW + 10_000, store)).toBe(MINUTE_MS);
    expect(twelveDataMinuteReadyDelayMs(NOW + 40_000, store)).toBe(MINUTE_MS - 30_000);
  });

  it("is 0 when a spend has been fully refunded (net zero in the window)", () => {
    const res = ledgerReservation(store);
    recordCredits(4, NOW, store);
    res.release("twelvedata", 4, NOW + 1_000);
    expect(twelveDataMinuteReadyDelayMs(NOW + 1_000, store)).toBe(0);
  });

  it("never exceeds a single minute", () => {
    recordCredits(8, NOW, store);
    expect(twelveDataMinuteReadyDelayMs(NOW, store)).toBeLessThanOrEqual(MINUTE_MS);
  });
});
