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
} from "../src/reservation";
import { recordCredits, recordTiingoCredits, type StorageLike } from "../src/cache";
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
});
