import { describe, expect, it } from "vitest";

import { describeLiveCoverage, liveRefreshProgress, manualRefreshSummary } from "../src/app";
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
  it("states how many holdings are up to date", () => {
    expect(manualRefreshSummary(report({ fetched: ["AAPL"] }))).toBe("Your holding is up to date");
    expect(manualRefreshSummary(report({ fetched: ["AAPL", "MSFT"] }))).toBe(
      "All 2 holdings up to date",
    );
  });

  it("counts cache-fresh holdings as up to date", () => {
    expect(manualRefreshSummary(report({ servedFresh: ["AAPL"] }))).toBe("Your holding is up to date");
  });

  it("explains a budget-deferred partial refresh with a precise count", () => {
    expect(manualRefreshSummary(report({ deferred: ["AAPL"] }))).toBe(
      "0/1 up to date · 1 still refreshing",
    );
  });

  it("reports a precise live/total count when some symbols are deferred", () => {
    expect(manualRefreshSummary(report({ fetched: ["AAPL"], deferred: ["MSFT"] }))).toBe(
      "1/2 up to date · 1 still refreshing",
    );
  });

  it("names lagging funds when only once-a-day NAV symbols are deferred", () => {
    expect(
      manualRefreshSummary(
        report({ fetched: ["AAPL", "MSFT"], deferred: ["VMFXX", "VTSAX"] }),
        new Set(["VMFXX", "VTSAX"]),
      ),
    ).toBe("2/4 up to date · stocks & ETFs done, 2 funds still refreshing");
  });

  it("surfaces a transient failure as a fallback message", () => {
    const err = new PriceError("rate limited", { retryable: true });
    expect(manualRefreshSummary(report({ error: err, deferred: ["AAPL"] }))).toBe(
      "Couldn't reach live prices — showing last known values",
    );
  });
});

describe("describeLiveCoverage", () => {
  it("reports nothing to price when there are no live holdings", () => {
    expect(describeLiveCoverage(report())).toBe("No live-priced holdings");
  });

  it("confirms full coverage when nothing is deferred", () => {
    expect(describeLiveCoverage(report({ fetched: ["AAPL"] }))).toBe("Your holding is up to date");
    expect(describeLiveCoverage(report({ fetched: ["AAPL"], servedFresh: ["MSFT"] }))).toBe(
      "All 2 holdings up to date",
    );
  });

  it("singles out a single deferred fund", () => {
    expect(
      describeLiveCoverage(
        report({ fetched: ["AAPL"], deferred: ["VMFXX"] }),
        new Set(["VMFXX"]),
      ),
    ).toBe("1/2 up to date · stocks & ETFs done, 1 fund still refreshing");
  });

  it("falls back to a plain count when market symbols are also deferred", () => {
    expect(
      describeLiveCoverage(
        report({ fetched: ["AAPL"], deferred: ["MSFT", "VMFXX"] }),
        new Set(["VMFXX"]),
      ),
    ).toBe("1/3 up to date · 2 still refreshing");
  });

  it("notes the data is stale when a fetch failed but nothing is deferred", () => {
    const err = new PriceError("offline", { retryable: true });
    expect(describeLiveCoverage(report({ error: err, servedFresh: ["AAPL", "MSFT"] }))).toBe(
      "Showing last known prices (2/2)",
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
