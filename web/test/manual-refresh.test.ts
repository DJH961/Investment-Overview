import { describe, expect, it } from "vitest";

import {
  allPricesLive,
  buildCoverageFacts,
  liveRefreshProgress,
  manualRefreshSummary,
  summarizeCoverage,
  type CoverageFacts,
} from "../src/app";
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

function facts(overrides: Partial<CoverageFacts> = {}): CoverageFacts {
  return {
    marketOpen: false,
    marketTotal: 0,
    marketLive: 0,
    navTotal: 0,
    navExpectedTonight: 0,
    navAwaiting: 0,
    freshlyPulled: true,
    error: false,
    fx: "live",
    ...overrides,
  };
}

describe("summarizeCoverage", () => {
  it("reports nothing to price when there are no live holdings", () => {
    expect(summarizeCoverage(facts())).toBe("No live-priced holdings · FX live");
  });

  it("market open: shows live market count and NAVs still expected tonight", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: true, marketTotal: 13, marketLive: 13, navTotal: 5, navExpectedTonight: 5 }),
      ),
    ).toBe("13/13 live, 5 NAVs expected tonight · FX live");
  });

  it("market open: a single fund reads in the singular", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: true, marketTotal: 2, marketLive: 2, navTotal: 1, navExpectedTonight: 1 }),
      ),
    ).toBe("2/2 live, 1 NAV expected tonight · FX live");
  });

  it("market open: once every NAV is in, it says so rather than 'expected'", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: true, marketTotal: 13, marketLive: 13, navTotal: 5, navExpectedTonight: 0 }),
      ),
    ).toBe("13/13 live, 5/5 NAVs in · FX live");
  });

  it("market closed: holds every close but is awaiting tonight's NAVs", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: false, marketTotal: 13, marketLive: 13, navTotal: 5, navAwaiting: 5 }),
      ),
    ).toBe("Market closed for 13/13, awaiting 5/5 NAVs · FX live");
  });

  it("market closed: everything current reads as fully up to date", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: false, marketTotal: 13, marketLive: 13, navTotal: 5, navAwaiting: 0 }),
      ),
    ).toBe("Market closed, all prices up to date · FX live");
  });

  it("market closed: a budget-deferred market close is named honestly", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: false, marketTotal: 13, marketLive: 11, navTotal: 5, navAwaiting: 3 }),
      ),
    ).toBe("Market closed, 11/13 up to date, awaiting 3/5 NAVs · FX live");
  });

  it("surfaces a hard error as last-known prices", () => {
    expect(summarizeCoverage(facts({ marketTotal: 2, marketLive: 2, error: true }))).toBe(
      "Showing last known prices · FX live",
    );
  });

  it("calls cache-served prices 'up to date' when the closed market is fully in hand", () => {
    // Served from cache, but the session is closed and every close/NAV is held —
    // the cached figures are the latest there are, so say so plainly rather than
    // the old apologetic "recent prices" (which read like a failed refresh).
    expect(
      summarizeCoverage(facts({ marketTotal: 2, marketLive: 2, freshlyPulled: false })),
    ).toBe("Up to date (2 holdings) · FX live");
    expect(
      summarizeCoverage(facts({ marketTotal: 1, marketLive: 1, freshlyPulled: false })),
    ).toBe("Up to date · FX live");
  });

  it("still says 'recent prices' from cache while something is genuinely behind", () => {
    // Market open and moving: cached prices may lag, so don't over-claim.
    expect(
      summarizeCoverage(
        facts({ marketOpen: true, marketTotal: 2, marketLive: 2, freshlyPulled: false }),
      ),
    ).toBe("Showing recent prices (2 holdings) · FX live");
    // Closed, but a NAV is still awaited: not yet up to date.
    expect(
      summarizeCoverage(
        facts({ marketTotal: 2, marketLive: 2, navTotal: 1, navAwaiting: 1, freshlyPulled: false }),
      ),
    ).toBe("Showing recent prices (3 holdings) · FX live");
  });

  it("always reports FX freshness, capitalised, alongside the price coverage", () => {
    const base = { marketOpen: false, marketTotal: 2, marketLive: 2 } as const;
    expect(summarizeCoverage(facts({ ...base, fx: "live" }))).toBe(
      "Market closed, all prices up to date · FX live",
    );
    expect(summarizeCoverage(facts({ ...base, fx: "eod" }))).toBe(
      "Market closed, all prices up to date · FX end of day",
    );
    expect(summarizeCoverage(facts({ ...base, fx: "cache" }))).toBe(
      "Market closed, all prices up to date · FX recent",
    );
    expect(summarizeCoverage(facts({ ...base, fx: "none" }))).toBe(
      "Market closed, all prices up to date · awaiting FX",
    );
  });
});

describe("buildCoverageFacts", () => {
  const now = new Date(2024, 4, 15, 18, 0, 0); // a Wednesday, 18:00 local

  it("splits market vs NAV holdings and counts live market symbols", () => {
    const f = buildCoverageFacts(
      report({ fetched: ["AAPL"], deferred: ["MSFT"] }),
      new Map(),
      new Set(),
      { now, marketOpen: true },
    );
    expect(f).toMatchObject({ marketTotal: 2, marketLive: 1, navTotal: 0 });
  });

  it("counts NAVs without today's value-date as expected tonight while open", () => {
    const quotes = new Map([["VTSAX", { valueDate: "2024-05-14" }]]); // yesterday's NAV
    const f = buildCoverageFacts(
      report({ servedFresh: ["VTSAX"] }),
      quotes,
      new Set(["VTSAX"]),
      { now, marketOpen: true, publishHourFor: () => 22 },
    );
    expect(f.navTotal).toBe(1);
    expect(f.navExpectedTonight).toBe(1);
    // 18:00 is before the 22:00 publish hour, so nothing is overdue yet.
    expect(f.navAwaiting).toBe(0);
  });

  it("flags a NAV as awaiting once it is past its publish hour and still missing", () => {
    const lateEvening = new Date(2024, 4, 15, 23, 0, 0); // 23:00 local, past publish hour
    const quotes = new Map([["VTSAX", { valueDate: "2024-05-14" }]]);
    const f = buildCoverageFacts(
      report({ fetched: ["VTSAX"] }),
      quotes,
      new Set(["VTSAX"]),
      { now: lateEvening, marketOpen: false, publishHourFor: () => 22 },
    );
    expect(f.navAwaiting).toBe(1);
  });
});

describe("manualRefreshSummary", () => {
  it("leads with the transparent coverage line", () => {
    expect(
      manualRefreshSummary(facts({ marketOpen: true, marketTotal: 2, marketLive: 2 })),
    ).toBe("2/2 live · FX live");
  });

  it("surfaces a transient failure as a fallback message", () => {
    expect(manualRefreshSummary(facts({ marketTotal: 1, error: true }))).toBe(
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

describe("allPricesLive", () => {
  it("is true when every requested symbol is fetched or cache-fresh", () => {
    expect(allPricesLive(report({ fetched: ["AAPL"], servedFresh: ["MSFT"] }))).toBe(true);
  });

  it("is false while any symbol is still deferred", () => {
    expect(allPricesLive(report({ fetched: ["AAPL"], deferred: ["MSFT"] }))).toBe(false);
  });

  it("is false when there are no priceable holdings at all", () => {
    expect(allPricesLive(report())).toBe(false);
  });

  it("is false when the round failed, even with nothing deferred", () => {
    const err = new PriceError("rate limited", { retryable: true });
    expect(allPricesLive(report({ fetched: ["AAPL"], error: err }))).toBe(false);
  });
});
