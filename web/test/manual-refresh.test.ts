import { describe, expect, it } from "vitest";

import {
  allPricesLive,
  buildCoverageFacts,
  classifyConnectivity,
  connectivityNotice,
  describePrefetch,
  describeTiingoError,
  displayFxSource,
  isUserRefresh,
  liveRefreshProgress,
  manualRefreshDecision,
  manualRefreshSummary,
  refreshTickAction,
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
    failed: [],
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
    marketHeld: 0,
    marketFresh: 0,
    marketAtClose: 0,
    navTotal: 0,
    navExpectedTonight: 0,
    navAwaiting: 0,
    freshlyPulled: true,
    error: false,
    fx: "live",
    fxMarketClosed: false,
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
        facts({
          marketOpen: true,
          marketTotal: 13,
          marketHeld: 13,
          marketFresh: 13,
          navTotal: 5,
          navExpectedTonight: 5,
        }),
      ),
    ).toBe("13/13 live, 5 NAVs expected tonight · FX live");
  });

  it("market open: splits freshly-pulled (live) from cached holdings", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: true, marketTotal: 13, marketHeld: 13, marketFresh: 8 }),
      ),
    ).toBe("8 live, 5 cached · FX live");
  });

  it("market open: never says 0/N when everything is held from cache", () => {
    // The "0/12 recent — how is that possible?" bug: budget-deferred holdings
    // still carry usable cached values, so they must read as held, not missing.
    expect(
      summarizeCoverage(facts({ marketOpen: true, marketTotal: 12, marketHeld: 12, marketFresh: 0 })),
    ).toBe("12/12 cached · FX live");
  });

  it("market open: a single fund reads in the singular", () => {
    expect(
      summarizeCoverage(
        facts({
          marketOpen: true,
          marketTotal: 2,
          marketHeld: 2,
          marketFresh: 2,
          navTotal: 1,
          navExpectedTonight: 1,
        }),
      ),
    ).toBe("2/2 live, 1 NAV expected tonight · FX live");
  });

  it("market open: once every NAV is in, it says so rather than 'expected'", () => {
    expect(
      summarizeCoverage(
        facts({
          marketOpen: true,
          marketTotal: 13,
          marketHeld: 13,
          marketFresh: 13,
          navTotal: 5,
          navExpectedTonight: 0,
        }),
      ),
    ).toBe("13/13 live, 5/5 NAVs in · FX live");
  });

  it("market closed: holds every close but is awaiting tonight's NAVs", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: false, marketTotal: 13, marketHeld: 13, marketAtClose: 13, navTotal: 5, navAwaiting: 5 }),
      ),
    ).toBe("Market closed, 13/13 at last close, awaiting 5/5 NAVs · FX live");
  });

  it("market closed: everything at closing prices reads as up to date, no update needed", () => {
    expect(
      summarizeCoverage(
        facts({ marketOpen: false, marketTotal: 13, marketHeld: 13, marketAtClose: 13, navTotal: 5, navAwaiting: 0 }),
      ),
    ).toBe("Market closed, up to date · FX live");
  });

  it("market closed: a budget-deferred market close is named honestly", () => {
    expect(
      summarizeCoverage(
        facts({
          marketOpen: false,
          marketTotal: 13,
          marketHeld: 13,
          marketAtClose: 11,
          navTotal: 5,
          navAwaiting: 3,
        }),
      ),
    ).toBe("Market closed, 11 at last close, 2 recent, awaiting 3/5 NAVs · FX live");
  });

  it("surfaces a hard error as last-known prices", () => {
    expect(summarizeCoverage(facts({ marketTotal: 2, marketHeld: 2, marketAtClose: 2, error: true }))).toBe(
      "Showing last known · FX live",
    );
  });

  it("calls cache-served prices 'up to date' when the closed market is fully in hand", () => {
    // Served from cache, but the session is closed and every close/NAV is held —
    // the cached figures are the latest there are, so say so plainly rather than
    // an apologetic count that reads like a failed refresh.
    expect(
      summarizeCoverage(facts({ marketTotal: 2, marketHeld: 2, marketAtClose: 2, freshlyPulled: false })),
    ).toBe("Market closed, up to date · FX live");
    expect(
      summarizeCoverage(facts({ marketTotal: 1, marketHeld: 1, marketAtClose: 1, freshlyPulled: false })),
    ).toBe("Market closed, up to date · FX live");
  });

  it("breaks cached coverage into recent vs awaiting while something is behind", () => {
    // Market open, served from cache (no fresh pull): the spots read as cached.
    expect(
      summarizeCoverage(
        facts({ marketOpen: true, marketTotal: 2, marketHeld: 2, marketFresh: 0, freshlyPulled: false }),
      ),
    ).toBe("2/2 cached · FX live");
    // Market open with an undue NAV: spots cached, NAV still expected tonight.
    expect(
      summarizeCoverage(
        facts({
          marketOpen: true,
          marketTotal: 2,
          marketHeld: 2,
          marketFresh: 0,
          navTotal: 1,
          navExpectedTonight: 1,
          freshlyPulled: false,
        }),
      ),
    ).toBe("2/2 cached, 1 NAV expected tonight · FX live");
    // Closed, holding both closes, but a NAV is still awaited.
    expect(
      summarizeCoverage(
        facts({
          marketTotal: 2,
          marketHeld: 2,
          marketAtClose: 2,
          navTotal: 1,
          navAwaiting: 1,
          freshlyPulled: false,
        }),
      ),
    ).toBe("Market closed, 2/2 at last close, awaiting 1/1 NAV · FX live");
  });

  it("always reports FX freshness, capitalised, alongside the price coverage", () => {
    const base = { marketOpen: false, marketTotal: 2, marketHeld: 2, marketAtClose: 2 } as const;
    expect(summarizeCoverage(facts({ ...base, fx: "live" }))).toBe(
      "Market closed, up to date · FX live",
    );
    expect(summarizeCoverage(facts({ ...base, fx: "eod" }))).toBe(
      "Market closed, up to date · FX end of day",
    );
    expect(summarizeCoverage(facts({ ...base, fx: "cache" }))).toBe(
      "Market closed, up to date · FX recent",
    );
    expect(summarizeCoverage(facts({ ...base, fx: "none" }))).toBe(
      "Market closed, up to date · awaiting FX",
    );
  });

  it("reports the forex weekend close as 'FX market closed', overriding the freshness label", () => {
    const base = { marketOpen: false, marketTotal: 2, marketHeld: 2, marketAtClose: 2 } as const;
    // Whatever the source label, a shut forex market freezes the rate at Friday's
    // close, so the clause says so plainly rather than implying a live/recent pull.
    expect(summarizeCoverage(facts({ ...base, fx: "cache", fxMarketClosed: true }))).toBe(
      "Market closed, up to date · FX market closed",
    );
    expect(summarizeCoverage(facts({ ...base, fx: "live", fxMarketClosed: true }))).toBe(
      "Market closed, up to date · FX market closed",
    );
  });
});

describe("buildCoverageFacts", () => {
  const now = new Date(2024, 4, 15, 18, 0, 0); // a Wednesday, 18:00 local

  it("splits market vs NAV holdings and counts freshly-pulled market symbols", () => {
    const f = buildCoverageFacts(
      report({ fetched: ["AAPL"], deferred: ["MSFT"] }),
      new Map(),
      new Set(),
      { now, marketOpen: true },
    );
    expect(f).toMatchObject({ marketTotal: 2, marketFresh: 1, navTotal: 0 });
  });

  it("counts a budget-deferred holding with a cached price as held, not missing", () => {
    // The "0/12 recent" bug: a deferred symbol that still has a usable cached
    // value must count as held so it never reads as missing.
    const quotes = new Map([["MSFT", { price: 1, valueDate: "2024-05-14" }]]);
    const f = buildCoverageFacts(
      report({ fetched: ["AAPL"], deferred: ["MSFT"] }),
      quotes,
      new Set(),
      { now, marketOpen: true },
    );
    expect(f.marketTotal).toBe(2);
    expect(f.marketHeld).toBe(1); // only MSFT carries a price in this synthetic map
    expect(f.marketFresh).toBe(1); // AAPL was fetched
  });

  it("counts NAVs without today's value-date as expected tonight while open", () => {
    const quotes = new Map([["VTSAX", { valueDate: "2024-05-14" }]]); // yesterday's NAV
    const f = buildCoverageFacts(
      report({ servedFresh: ["VTSAX"] }),
      quotes,
      new Set(["VTSAX"]),
      { now, marketOpen: true },
    );
    expect(f.navTotal).toBe(1);
    expect(f.navExpectedTonight).toBe(1);
    // We already hold the latest settled session's NAV, so nothing is overdue.
    expect(f.navAwaiting).toBe(0);
  });

  it("flags a fund behind the latest settled session's NAV as awaiting once closed", () => {
    // Mutual funds strike after the close: the US session has just settled but
    // tonight's NAV hasn't landed yet, so the fund is behind the settled session.
    // The whole after-close, pre-NAV window now reads "awaiting" — exactly the
    // "we are awaiting tonight's NAV" state the user expects — with no attempt to
    // predict when it will publish.
    const evening = new Date(2024, 0, 10, 22, 30); // Wed 17:30 ET — session settled
    const quotes = new Map([["VTSAX", { valueDate: "2024-01-09" }]]); // prior session NAV
    const f = buildCoverageFacts(
      report({ servedFresh: ["VTSAX"] }),
      quotes,
      new Set(["VTSAX"]),
      { now: evening, marketOpen: false },
    );
    expect(f.navTotal).toBe(1);
    expect(f.navAwaiting).toBe(1);
  });

  it("counts a failed market symbol toward the total (held only if it has a cached price)", () => {
    // A symbol the provider attempted but couldn't price this round is reported in
    // `failed`; it must still count toward marketTotal (and as held when a cached
    // price remains), never silently vanish from coverage.
    const quotes = new Map([["AAPL", { price: 1, valueDate: "2024-05-14" }]]);
    const f = buildCoverageFacts(
      report({ fetched: ["AAPL"], failed: ["FSKAX"] }),
      quotes,
      new Set(),
      { now, marketOpen: true },
    );
    expect(f.marketTotal).toBe(2); // AAPL + FSKAX
    expect(f.marketHeld).toBe(1); // only AAPL has a cached price here
    expect(f.marketFresh).toBe(1);
  });

  it("flags the latest due NAV as awaiting when we don't hold it yet", () => {
    // Market open, but the fund is behind even the prior settled session's NAV
    // (a genuine provider outage, not just tonight's not-yet-struck NAV): coverage
    // must read "awaiting" and never claim everything is up to date.
    const f = buildCoverageFacts(
      report({ servedFresh: ["VTSAX"] }),
      new Map([["VTSAX", { valueDate: "2024-05-10" }]]), // a stale, days-old NAV
      new Set(["VTSAX"]),
      { now, marketOpen: true },
    );
    expect(f.navTotal).toBe(1);
    expect(f.navAwaiting).toBe(1);
    expect(f.navExpectedTonight).toBe(0);
  });

  it("does not claim today's NAV is missing pre-market when the latest session's NAV is in", () => {
    // Early hours of a trading day, before the open: the most recent NAV we can
    // possibly hold is the prior settled session's, and we have it. Nothing is
    // awaiting and nothing is expected tonight yet (today's session hasn't begun).
    const preMarket = new Date(2024, 4, 15, 11, 0, 0); // Wed 11:00 UTC — before 13:30 open
    const f = buildCoverageFacts(
      report({ servedFresh: ["VTSAX"] }),
      new Map([["VTSAX", { valueDate: "2024-05-14" }]]), // prior session's NAV, in hand
      new Set(["VTSAX"]),
      { now: preMarket, marketOpen: false },
    );
    expect(f.navTotal).toBe(1);
    expect(f.navAwaiting).toBe(0);
    expect(f.navExpectedTonight).toBe(0);
  });

  it("awaits the just-settled session's NAV until it lands, however late", () => {
    // Late evening after a trading day: the session has settled (we should hold
    // tonight's NAV) but we still only have the prior session's. There is no
    // publish-lag grace any more — we await it until it arrives, however late, so
    // the line reads "awaiting" rather than prematurely "up to date".
    const lateEvening = new Date(2024, 4, 16, 3, 0, 0); // Thu 03:00 UTC → Wed 23:00 ET
    const f = buildCoverageFacts(
      report({ servedFresh: ["VTSAX"] }),
      new Map([["VTSAX", { valueDate: "2024-05-14" }]]), // Tue NAV; Wed's settled but not held
      new Set(["VTSAX"]),
      { now: lateEvening, marketOpen: false, fx: "live" },
    );
    expect(f.navTotal).toBe(1);
    expect(f.navAwaiting).toBe(1);
    // Market is closed and we are behind the settled session, so the line awaits.
    expect(summarizeCoverage(f)).toBe("Market closed, awaiting 1/1 NAV · FX live");
  });

  it("still awaits a NAV that is more than one trading day behind", () => {
    // A genuinely overdue NAV (the provider has failed for days) is still behind
    // the settled session, so it must read "awaiting".
    const lateEvening = new Date(2024, 4, 16, 3, 0, 0); // Thu 03:00 UTC → Wed 23:00 ET
    const f = buildCoverageFacts(
      report({ servedFresh: ["VTSAX"] }),
      new Map([["VTSAX", { valueDate: "2024-05-10" }]]), // days-old NAV
      new Set(["VTSAX"]),
      { now: lateEvening, marketOpen: false },
    );
    expect(f.navTotal).toBe(1);
    expect(f.navAwaiting).toBe(1);
  });

  it("counts a cache-served holding observed within the live window as live, not cached", () => {
    // The "always cached" confusion: a budget-deferred symbol whose cached spot was
    // observed two minutes ago is, to the user, just as live as one re-pulled this
    // round — so it joins the "live" bucket rather than being labelled "cached".
    const twoMinAgo = now.getTime() - 2 * 60 * 1000;
    const quotes = new Map([["MSFT", { price: 1, at: twoMinAgo, valueDate: "2024-05-15" }]]);
    const f = buildCoverageFacts(
      report({ deferred: ["MSFT"] }),
      quotes,
      new Set(),
      { now, marketOpen: true, liveStalenessMs: 15 * 60 * 1000 },
    );
    expect(f.marketTotal).toBe(1);
    expect(f.marketHeld).toBe(1);
    expect(f.marketFresh).toBe(1); // promoted: recently confirmed cache reads as live
    expect(summarizeCoverage({ ...f, fx: "live" })).toBe("1/1 live · FX live");
  });

  it("keeps a genuinely aged cache-served holding as cached, not live", () => {
    // Observed well beyond the live window → it has not been confirmed recently, so
    // it honestly stays "cached" rather than overstating freshness.
    const fortyMinAgo = now.getTime() - 40 * 60 * 1000;
    const quotes = new Map([["MSFT", { price: 1, at: fortyMinAgo, valueDate: "2024-05-15" }]]);
    const f = buildCoverageFacts(
      report({ deferred: ["MSFT"] }),
      quotes,
      new Set(),
      { now, marketOpen: true, liveStalenessMs: 15 * 60 * 1000 },
    );
    expect(f.marketFresh).toBe(0);
    expect(summarizeCoverage({ ...f, fx: "live" })).toBe("1/1 cached · FX live");
  });

  it("does not promote a fresh cache to live while the market is closed", () => {
    // "Live" is only a meaningful claim during the session; once closed, the
    // settled-close messaging governs, so a recent cache must not read as live.
    const oneMinAgo = now.getTime() - 60 * 1000;
    const quotes = new Map([["MSFT", { price: 1, at: oneMinAgo, valueDate: "2024-05-15" }]]);
    const f = buildCoverageFacts(
      report({ deferred: ["MSFT"] }),
      quotes,
      new Set(),
      { now, marketOpen: false, liveStalenessMs: 15 * 60 * 1000 },
    );
    expect(f.marketFresh).toBe(0);
  });
});

describe("displayFxSource", () => {
  const t = Date.UTC(2024, 4, 15, 18, 0, 0);

  it("promotes an extremely fresh cached spot to live", () => {
    // Served from cache but observed seconds ago → to the user, just as live as
    // the market prices it values.
    expect(displayFxSource("cache", t - 30_000, t)).toBe("live");
  });

  it("keeps a genuinely aged cached spot as recent", () => {
    // Older than the live-staleness window (15 min) → still "recent", not live.
    expect(displayFxSource("cache", t - 30 * 60_000, t)).toBe("cache");
  });

  it("passes every other source through unchanged", () => {
    expect(displayFxSource("live", t, t)).toBe("live");
    expect(displayFxSource("eod", t - 60_000, t)).toBe("eod");
    expect(displayFxSource("none", null, t)).toBe("none");
    expect(displayFxSource("cache", null, t)).toBe("cache");
  });

  it("ties the FX live window to the configured refresh interval", () => {
    // A spot observed 5 min ago is "live" under the default 15-min window, but a
    // 2-min refresh interval narrows it to "cache"; a 30-min interval widens a
    // 20-min-old spot back to "live".
    expect(displayFxSource("cache", t - 5 * 60_000, t, 2 * 60_000)).toBe("cache");
    expect(displayFxSource("cache", t - 5 * 60_000, t, 30 * 60_000)).toBe("live");
    expect(displayFxSource("cache", t - 20 * 60_000, t, 30 * 60_000)).toBe("live");
  });
});

describe("manualRefreshSummary", () => {
  it("leads with the transparent coverage line", () => {
    expect(
      manualRefreshSummary(facts({ marketOpen: true, marketTotal: 2, marketHeld: 2, marketFresh: 2 })),
    ).toBe("2/2 live · FX live");
  });

  it("surfaces a transient failure as a fallback message", () => {
    expect(manualRefreshSummary(facts({ marketTotal: 1, error: true }))).toBe(
      "Couldn't reach live prices, showing last known.",
    );
  });
});



describe("manualRefreshDecision", () => {
  const idle = { refreshing: false, inFlightKind: null, lastManualAt: 0, now: 1_000_000 } as const;

  it("runs a tap when nothing is in flight and the cooldown has lapsed", () => {
    expect(manualRefreshDecision(idle)).toBe("run");
  });

  it("swallows an accidental double-tap inside the cooldown window", () => {
    // A second tap a few hundred ms after an accepted one must not fire a second
    // forced pull — it is treated as a double-click.
    expect(
      manualRefreshDecision({ ...idle, lastManualAt: idle.now - 400 }),
    ).toBe("cooldown");
  });

  it("still allows a deliberate re-check once the (tiny) cooldown has passed", () => {
    expect(
      manualRefreshDecision({ ...idle, lastManualAt: idle.now - 3500 }),
    ).toBe("run");
  });

  it("honours a custom cooldown window", () => {
    expect(
      manualRefreshDecision({ ...idle, lastManualAt: idle.now - 5000, cooldownMs: 10_000 }),
    ).toBe("cooldown");
  });

  it("promotes an in-flight automatic pull so the manual tap takes priority", () => {
    expect(
      manualRefreshDecision({ ...idle, refreshing: true, inFlightKind: "auto" }),
    ).toBe("promote");
  });

  it("treats a tap during an in-flight manual pull as a double-tap (no second pull)", () => {
    expect(
      manualRefreshDecision({ ...idle, refreshing: true, inFlightKind: "manual" }),
    ).toBe("cooldown");
  });

  it("cooldown wins over promotion when a tap double-fires during an auto pull", () => {
    // The first tap promoted the auto round and stamped lastManualAt; an immediate
    // second tap (still mid-pull) must be swallowed rather than re-promoting.
    expect(
      manualRefreshDecision({
        refreshing: true,
        inFlightKind: "auto",
        lastManualAt: idle.now - 200,
        now: idle.now,
      }),
    ).toBe("cooldown");
  });
});

describe("refreshTickAction", () => {
  it("stops a superseded session outright (no re-arm, no run)", () => {
    expect(
      refreshTickAction({ sessionMatches: false, kind: "auto", hidden: false, kickoff: false }),
    ).toBe("stop");
    // Even a kickoff for a stale session must not run.
    expect(
      refreshTickAction({ sessionMatches: false, kind: "auto", hidden: true, kickoff: true }),
    ).toBe("stop");
  });

  it("defers (skips the network but keeps the loop alive) for a hidden auto tick", () => {
    expect(
      refreshTickAction({ sessionMatches: true, kind: "auto", hidden: true, kickoff: false }),
    ).toBe("defer");
  });

  it("runs an ordinary auto tick while the tab is visible", () => {
    expect(
      refreshTickAction({ sessionMatches: true, kind: "auto", hidden: false, kickoff: false }),
    ).toBe("run");
  });

  it("always runs the post-unlock kickoff, even when the tab reports hidden", () => {
    // The fingerprint-unlock bug: a momentarily-hidden tab must not drop the
    // startup refresh, or no price update ever fires until a manual tap.
    expect(
      refreshTickAction({ sessionMatches: true, kind: "auto", hidden: true, kickoff: true }),
    ).toBe("run");
  });

  it("never skips a manual tap, hidden or not", () => {
    expect(
      refreshTickAction({ sessionMatches: true, kind: "manual", hidden: true, kickoff: false }),
    ).toBe("run");
    expect(
      refreshTickAction({ sessionMatches: true, kind: "manual", hidden: false, kickoff: false }),
    ).toBe("run");
  });

  it("runs the login warm-up (start) and reset re-pull even on a hidden tab", () => {
    // Only the steady `auto` cadence defers when hidden; the user-/login-driven
    // mechanisms always run so a freshly-unlocked or reset session paints prices.
    for (const kind of ["start", "reset"] as const) {
      expect(
        refreshTickAction({ sessionMatches: true, kind, hidden: true, kickoff: false }),
      ).toBe("run");
    }
  });
});

describe("isUserRefresh", () => {
  it("is true only for the user-triggered mechanisms (manual, reset)", () => {
    expect(isUserRefresh("manual")).toBe(true);
    expect(isUserRefresh("reset")).toBe(true);
  });

  it("is false for the background mechanisms (start, auto)", () => {
    expect(isUserRefresh("start")).toBe(false);
    expect(isUserRefresh("auto")).toBe(false);
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

  it("counts a failed symbol as not-live, lowering the live total", () => {
    const p = liveRefreshProgress(report({ fetched: ["AAPL"], failed: ["FSKAX"] }));
    expect(p).toEqual({ live: 1, total: 2 });
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

  it("is false when a symbol was attempted but failed to price", () => {
    expect(allPricesLive(report({ fetched: ["AAPL"], failed: ["FSKAX"] }))).toBe(false);
  });

  it("is false when the round failed, even with nothing deferred", () => {
    const err = new PriceError("rate limited", { retryable: true });
    expect(allPricesLive(report({ fetched: ["AAPL"], error: err }))).toBe(false);
  });
});

describe("classifyConnectivity", () => {
  const base = {
    online: true,
    fetched: 0,
    fxFetched: false,
    quoteError: null,
    tiingoError: null,
  } as const;

  it("is offline whenever the device reports no link, regardless of what else happened", () => {
    expect(classifyConnectivity({ ...base, online: false })).toBe("offline");
    // Even a fetch that 'landed' is moot once the device says it is offline.
    expect(classifyConnectivity({ ...base, online: false, fetched: 3 })).toBe("offline");
  });

  it("is online when a quote or a live FX rate actually landed", () => {
    expect(classifyConnectivity({ ...base, fetched: 2 })).toBe("online");
    expect(classifyConnectivity({ ...base, fxFetched: true })).toBe("online");
  });

  it("is unreachable when nothing landed and a provider failed transiently", () => {
    const err = new PriceError("network down", { retryable: true });
    expect(classifyConnectivity({ ...base, quoteError: err })).toBe("unreachable");
    expect(classifyConnectivity({ ...base, tiingoError: err })).toBe("unreachable");
  });

  it("stays online (up to date) when nothing landed but nothing errored either", () => {
    // A clean round with nothing newer to fetch is not a connectivity problem.
    expect(classifyConnectivity(base)).toBe("online");
  });

  it("does not mark a fatal (config) error as unreachable — that routes to Settings", () => {
    const fatal = new PriceError("bad key", { fatal: true });
    expect(classifyConnectivity({ ...base, quoteError: fatal })).toBe("online");
  });
});

describe("connectivityNotice", () => {
  it("names the offline and unreachable cases plainly, and is silent when online", () => {
    expect(connectivityNotice("offline")).toBe("No internet connection, showing last known.");
    expect(connectivityNotice("unreachable")).toBe(
      "Couldn't reach any price service, showing last known.",
    );
    expect(connectivityNotice("online")).toBeNull();
  });
});

describe("describeTiingoError", () => {
  it("distinguishes a rate-limit (429) from an unreachable backup, sharing one wording", () => {
    expect(describeTiingoError(new PriceError("rate", { status: 429 }))).toBe(
      "Backup (Tiingo) rate-limited; its credits look used up.",
    );
    expect(describeTiingoError(new PriceError("down", { status: 503 }))).toBe(
      "Backup (Tiingo) unreachable; check the price proxy Worker.",
    );
    expect(describeTiingoError(new PriceError("dns"))).toBe(
      "Backup (Tiingo) unreachable; check the price proxy Worker.",
    );
  });
});

describe("describePrefetch", () => {
  const at = new Date(2024, 4, 15, 18, 0, 0).getTime();
  const now = new Date(2024, 4, 15, 18, 3, 0).getTime(); // 3 min later

  it("shows a warming line while still in flight", () => {
    expect(
      describePrefetch({
        inFlight: true,
        hasPlan: true,
        quoteFetched: 0,
        quoteTotal: 12,
        fxLive: false,
        lastPullAt: null,
      }),
    ).toBe("Warming live prices…");
  });

  it("appends the last-pulled clause to the warming line when known", () => {
    const s = describePrefetch({
      inFlight: true,
      hasPlan: true,
      quoteFetched: 0,
      quoteTotal: 12,
      fxLive: false,
      lastPullAt: at,
      now,
    });
    expect(s).toMatch(/^Warming live prices… · last pulled/);
  });

  it("reports the count and FX when the prefetch fetched something new", () => {
    const s = describePrefetch({
      inFlight: false,
      hasPlan: true,
      quoteFetched: 12,
      quoteTotal: 14,
      fxLive: true,
      lastPullAt: at,
      now,
    });
    expect(s).toMatch(/^Prefetched 12\/14 live · FX live · last pulled/);
  });

  it("says already up to date when nothing new was pulled", () => {
    const s = describePrefetch({
      inFlight: false,
      hasPlan: true,
      quoteFetched: 0,
      quoteTotal: 14,
      fxLive: false,
      lastPullAt: at,
      now,
    });
    expect(s).toMatch(/^Already up to date · last pulled/);
  });

  it("confirms readiness on a first ever run with no plan", () => {
    expect(
      describePrefetch({
        inFlight: false,
        hasPlan: false,
        quoteFetched: 0,
        quoteTotal: 0,
        fxLive: false,
        lastPullAt: null,
      }),
    ).toBe("Live prices ready");
  });

  it("counts graph bars as freshly pulled, even when no quote/FX moved", () => {
    const s = describePrefetch({
      inFlight: false,
      hasPlan: true,
      quoteFetched: 0,
      quoteTotal: 5,
      fxLive: false,
      graphFetched: 7,
      lastPullAt: at,
      now,
    });
    expect(s).toMatch(/^Prefetched 7 graph · last pulled/);
  });

  it("combines quote, graph and FX clauses when all moved", () => {
    const s = describePrefetch({
      inFlight: false,
      hasPlan: true,
      quoteFetched: 3,
      quoteTotal: 10,
      fxLive: true,
      graphFetched: 4,
      lastPullAt: at,
      now,
    });
    expect(s).toMatch(/^Prefetched 3\/10 live · 4 graph · FX live · last pulled/);
  });
});
