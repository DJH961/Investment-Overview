import { describe, expect, it } from "vitest";

import { liveRefreshProgress, manualRefreshSummary } from "../src/app";
import type { QuoteLoadReport } from "../src/quotes";
import { PriceError } from "../src/prices";

function report(overrides: Partial<QuoteLoadReport> = {}): QuoteLoadReport {
  return {
    fetched: [],
    servedFresh: [],
    deferred: [],
    error: null,
    minuteRemaining: 8,
    dayRemaining: 800,
    ...overrides,
  };
}

describe("manualRefreshSummary", () => {
  it("reports how many quotes were freshly fetched", () => {
    expect(manualRefreshSummary(report({ fetched: ["AAPL"] }))).toBe("Prices updated (1 quote refreshed)");
    expect(manualRefreshSummary(report({ fetched: ["AAPL", "MSFT"] }))).toBe(
      "Prices updated (2 quotes refreshed)",
    );
  });

  it("reassures when everything was already fresh from cache", () => {
    expect(manualRefreshSummary(report({ servedFresh: ["AAPL"] }))).toBe("Prices are up to date");
  });

  it("explains a budget-deferred partial refresh", () => {
    expect(manualRefreshSummary(report({ deferred: ["AAPL"] }))).toBe(
      "Some prices queued — they'll refresh shortly",
    );
  });

  it("prefers a fetched count over deferred symbols", () => {
    expect(manualRefreshSummary(report({ fetched: ["AAPL"], deferred: ["MSFT"] }))).toBe(
      "Prices updated (1 quote refreshed)",
    );
  });

  it("surfaces a transient failure as a fallback message", () => {
    const err = new PriceError("rate limited", { retryable: true });
    expect(manualRefreshSummary(report({ error: err, deferred: ["AAPL"] }))).toBe(
      "Couldn't reach live prices — showing last known values",
    );
  });
});

describe("liveRefreshProgress", () => {
  it("counts freshly-fetched and cache-fresh symbols as live out of the total", () => {
    const p = liveRefreshProgress(
      report({ fetched: ["AAPL", "MSFT"], servedFresh: ["VWCE"], deferred: ["NVDA", "AMD"] }),
    );
    expect(p).toEqual({ live: 3, total: 5 });
  });

  it("is complete (live === total) when nothing is deferred", () => {
    const p = liveRefreshProgress(report({ fetched: ["AAPL"], servedFresh: ["MSFT"] }));
    expect(p).toEqual({ live: 2, total: 2 });
  });

  it("reports zero live while everything is still deferred", () => {
    const p = liveRefreshProgress(report({ deferred: ["A", "B", "C"] }));
    expect(p).toEqual({ live: 0, total: 3 });
  });
});
