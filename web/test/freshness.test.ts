import { describe, expect, it } from "vitest";
import {
  ONE_HOUR_MS,
  allLegs,
  barClockHourDue,
  ceilToClockHour,
  gradedPull,
  hasAnyLeg,
  holdingCoversLatestClose,
  holdingFreshness,
  noLegs,
  quoteRefreshDue,
  fxFreshness,
  type FreshnessInputs,
  type FxFreshnessInput,
} from "../src/freshness";

const MIN = 60 * 1000;

function inputs(over: Partial<FreshnessInputs> = {}): FreshnessInputs {
  return {
    dataAgeMs: 0,
    deviceDaysMissing: 0,
    blobDaysOld: 0,
    market: "open",
    minutesSinceOpenMs: 4 * ONE_HOUR_MS,
    autoIntervalMs: 15 * MIN,
    navHeldForToday: true,
    ...over,
  };
}

describe("leg helpers", () => {
  it("noLegs is all-off, allLegs is all-on", () => {
    expect(hasAnyLeg(noLegs())).toBe(false);
    expect(hasAnyLeg(allLegs())).toBe(true);
    const a = allLegs();
    expect(a.weekBars && a.dayBars && a.quotes && a.nav && a.fx).toBe(true);
  });
});

describe("gradedPull truth-table", () => {
  it("heavily-outdated when >1 day missing AND blob >1 day old ⇒ everything", () => {
    const g = gradedPull(inputs({ deviceDaysMissing: 3, blobDaysOld: 2, dataAgeMs: 5 * ONE_HOUR_MS }));
    expect(g.tier).toBe("heavily-outdated");
    expect(g.legs).toEqual(allLegs());
  });

  it("not heavily-outdated if a fresh blob covers the gap (blob ≤1 day)", () => {
    // Device behind, but the best-available blob is current → not heavily.
    const g = gradedPull(inputs({ deviceDaysMissing: 3, blobDaysOld: 1, dataAgeMs: 2 * ONE_HOUR_MS }));
    expect(g.tier).not.toBe("heavily-outdated");
  });

  it("minorly-outdated, market open ≥30m ⇒ 1D bars + quotes + FX", () => {
    const g = gradedPull(inputs({ dataAgeMs: 2 * ONE_HOUR_MS, minutesSinceOpenMs: 2 * ONE_HOUR_MS }));
    expect(g.tier).toBe("minorly-outdated");
    expect(g.legs.dayBars).toBe(true);
    expect(g.legs.quotes).toBe(true);
    expect(g.legs.fx).toBe(true);
    expect(g.legs.weekBars).toBe(false);
  });

  it("minorly-outdated, market open <30m ⇒ quotes only (no bars)", () => {
    const g = gradedPull(inputs({ dataAgeMs: 2 * ONE_HOUR_MS, minutesSinceOpenMs: 10 * MIN }));
    expect(g.tier).toBe("minorly-outdated");
    expect(g.legs.dayBars).toBe(false);
    expect(g.legs.quotes).toBe(true);
    expect(g.legs.fx).toBe(true);
  });

  it("minorly-outdated, closed ⇒ 1D series (bars + quotes + FX)", () => {
    const g = gradedPull(inputs({ market: "closed", minutesSinceOpenMs: 0, dataAgeMs: 2 * ONE_HOUR_MS }));
    expect(g.tier).toBe("minorly-outdated");
    expect(g.legs.dayBars).toBe(true);
  });

  it("relatively-fresh, open ⇒ quotes + FX (market data)", () => {
    const g = gradedPull(inputs({ dataAgeMs: 30 * MIN }));
    expect(g.tier).toBe("relatively-fresh");
    expect(g.legs.quotes).toBe(true);
    expect(g.legs.fx).toBe(true);
    expect(g.legs.dayBars).toBe(false);
  });

  it("relatively-fresh, closed, NAV missing ⇒ NAV + FX only", () => {
    const g = gradedPull(inputs({ market: "closed", minutesSinceOpenMs: 0, dataAgeMs: 30 * MIN, navHeldForToday: false }));
    expect(g.tier).toBe("relatively-fresh");
    expect(g.legs.nav).toBe(true);
    expect(g.legs.fx).toBe(true);
    expect(g.legs.quotes).toBe(false);
    expect(g.legs.dayBars).toBe(false);
  });

  it("relatively-fresh, closed, NAV present ⇒ FX only", () => {
    const g = gradedPull(inputs({ market: "closed", minutesSinceOpenMs: 0, dataAgeMs: 30 * MIN, navHeldForToday: true }));
    expect(g.tier).toBe("relatively-fresh");
    expect(g.legs.fx).toBe(true);
    expect(g.legs.nav).toBe(false);
    expect(g.legs.quotes).toBe(false);
  });

  it("fresh (younger than one interval) ⇒ nothing — a seconds-later re-login is a no-op", () => {
    const g = gradedPull(inputs({ dataAgeMs: 2 * MIN, autoIntervalMs: 15 * MIN }));
    expect(g.tier).toBe("fresh");
    expect(hasAnyLeg(g.legs)).toBe(false);
  });
});

describe("clock-hour bar gate", () => {
  it("ceilToClockHour rounds up to the next :00 (and is idempotent on a boundary)", () => {
    const base = Date.UTC(2026, 5, 25, 15, 0, 0);
    expect(ceilToClockHour(base + 30 * MIN)).toBe(Date.UTC(2026, 5, 25, 16, 0, 0));
    expect(ceilToClockHour(base)).toBe(base);
  });

  it("first bar of the session waits one interval after the open", () => {
    const open = Date.UTC(2026, 5, 25, 13, 30, 0); // 09:30 ET ≈ 13:30 UTC
    expect(barClockHourDue({ nowMs: open + 5 * MIN, lastBarPullMs: null, sessionOpenMs: open })).toBe(false);
    expect(barClockHourDue({ nowMs: open + ONE_HOUR_MS, lastBarPullMs: null, sessionOpenMs: open })).toBe(true);
  });

  it("after a 15:30 pull the next bar is due at 17:00, not before", () => {
    const open = Date.UTC(2026, 5, 25, 13, 30, 0);
    const lastPull = Date.UTC(2026, 5, 25, 15, 30, 0);
    const at1545 = Date.UTC(2026, 5, 25, 15, 45, 0);
    const at1659 = Date.UTC(2026, 5, 25, 16, 59, 0);
    const at1700 = Date.UTC(2026, 5, 25, 17, 0, 0);
    expect(barClockHourDue({ nowMs: at1545, lastBarPullMs: lastPull, sessionOpenMs: open })).toBe(false);
    expect(barClockHourDue({ nowMs: at1659, lastBarPullMs: lastPull, sessionOpenMs: open })).toBe(false);
    expect(barClockHourDue({ nowMs: at1700, lastBarPullMs: lastPull, sessionOpenMs: open })).toBe(true);
  });

  it("a pull aligned exactly to :00 allows the next at the following :00", () => {
    const open = Date.UTC(2026, 5, 25, 13, 30, 0);
    const lastPull = Date.UTC(2026, 5, 25, 15, 0, 0);
    expect(barClockHourDue({ nowMs: Date.UTC(2026, 5, 25, 15, 59, 0), lastBarPullMs: lastPull, sessionOpenMs: open })).toBe(false);
    expect(barClockHourDue({ nowMs: Date.UTC(2026, 5, 25, 16, 0, 0), lastBarPullMs: lastPull, sessionOpenMs: open })).toBe(true);
  });
});

describe("rolling quote TTL", () => {
  it("is due only once the rolling window has elapsed", () => {
    const now = Date.UTC(2026, 5, 25, 15, 0, 0);
    const FIFTEEN_MIN = 15 * MIN;
    expect(quoteRefreshDue(now - (FIFTEEN_MIN - 1), now, FIFTEEN_MIN)).toBe(false);
    expect(quoteRefreshDue(now - FIFTEEN_MIN, now, FIFTEEN_MIN)).toBe(true);
  });
});

describe("holdingFreshness (per-row tier)", () => {
  // Use a local noon so "same local day" comparisons are unambiguous in any TZ.
  const now = new Date(2026, 5, 25, 12, 0, 0).getTime();
  const WINDOW = 15 * MIN;

  it("is 'live' when the market is open and observed within the window", () => {
    expect(
      holdingFreshness({ observedAtMs: now - 2 * MIN, nowMs: now, marketOpen: true, liveWindowMs: WINDOW }),
    ).toBe("live");
  });

  it("is 'recent' (not 'live') when the market is shut, even within the window", () => {
    expect(
      holdingFreshness({ observedAtMs: now - 2 * MIN, nowMs: now, marketOpen: false, liveWindowMs: WINDOW }),
    ).toBe("recent");
  });

  it("is 'recent' when observed today but older than the live window", () => {
    expect(
      holdingFreshness({ observedAtMs: now - 90 * MIN, nowMs: now, marketOpen: true, liveWindowMs: WINDOW }),
    ).toBe("recent");
  });

  it("is 'aged' when the newest observation is from an earlier day", () => {
    const yesterday = new Date(2026, 5, 24, 16, 0, 0).getTime();
    expect(
      holdingFreshness({ observedAtMs: yesterday, nowMs: now, marketOpen: true, liveWindowMs: WINDOW }),
    ).toBe("aged");
  });

  it("is 'aged' when there is no live/cached observation at all (export fallback)", () => {
    expect(
      holdingFreshness({ observedAtMs: null, nowMs: now, marketOpen: true, liveWindowMs: WINDOW }),
    ).toBe("aged");
  });

  it("never reads 'live' for a future-stamped observation (clock skew)", () => {
    expect(
      holdingFreshness({ observedAtMs: now + 5 * MIN, nowMs: now, marketOpen: true, liveWindowMs: WINDOW }),
    ).toBe("recent");
  });
});

describe("fxFreshness (Layer-6 FX tier)", () => {
  const WINDOW = 15 * MIN;
  // 2026-06-24 16:00 UTC = Wed 12:00 ET (EDT) — forex market open.
  const wedNow = new Date(Date.UTC(2026, 5, 24, 16, 0, 0));
  // 2026-06-27 16:00 UTC = Sat — forex market shut (weekend close).
  const satNow = new Date(Date.UTC(2026, 5, 27, 16, 0, 0));

  function fx(over: Partial<FxFreshnessInput> = {}): FxFreshnessInput {
    return { hasRate: true, fxObservedAt: wedNow.getTime() - 2 * MIN, now: wedNow, intervalMs: WINDOW, ...over };
  }

  it("is 'none' when no rate is held at all", () => {
    expect(fxFreshness(fx({ hasRate: false }))).toBe("none");
    // 'none' wins even if an observation instant happens to be present.
    expect(fxFreshness(fx({ hasRate: false, fxObservedAt: wedNow.getTime() }))).toBe("none");
  });

  it("is 'eod' for a keyless rate (present but no observation instant)", () => {
    expect(fxFreshness(fx({ fxObservedAt: null }))).toBe("eod");
  });

  it("is 'live' when forex is open and observed within the window", () => {
    expect(fxFreshness(fx({ fxObservedAt: wedNow.getTime() - 2 * MIN }))).toBe("live");
  });

  it("is 'recent' (not 'live') when the forex market is shut, even within the window", () => {
    expect(
      fxFreshness(fx({ now: satNow, fxObservedAt: satNow.getTime() - 2 * MIN })),
    ).toBe("recent");
  });

  it("is 'recent' when observed this week but older than the live window", () => {
    expect(fxFreshness(fx({ fxObservedAt: wedNow.getTime() - 90 * MIN }))).toBe("recent");
  });

  it("is 'aged' when the rate predates the most recent forex reopen", () => {
    // Observed the prior Friday — before Sunday 17:00 ET reopen — and far outside
    // the live window: genuinely aged.
    const priorFriday = new Date(Date.UTC(2026, 5, 19, 16, 0, 0)).getTime();
    expect(fxFreshness(fx({ fxObservedAt: priorFriday }))).toBe("aged");
  });
});

describe("holdingCoversLatestClose — absolute up-to-date driver", () => {
  const SETTLED = "2026-06-26";

  it("is current when the price value-date is the latest settled session", () => {
    expect(
      holdingCoversLatestClose({ priceDateIso: SETTLED, latestSettledSessionIso: SETTLED }),
    ).toBe(true);
  });

  it("is current when the price value-date is newer than the settled session", () => {
    expect(
      holdingCoversLatestClose({ priceDateIso: "2026-06-29", latestSettledSessionIso: SETTLED }),
    ).toBe(true);
  });

  it("is behind when the price value-date trails the latest settled session", () => {
    expect(
      holdingCoversLatestClose({ priceDateIso: "2026-06-25", latestSettledSessionIso: SETTLED }),
    ).toBe(false);
  });

  it("treats a once-a-day NAV still on the prior session as behind (not yet published)", () => {
    // A mutual fund whose newest bar is the prior trading day reads behind until
    // its new NAV publishes and is pulled — the morning "this fund hasn't updated"
    // signal.
    expect(
      holdingCoversLatestClose({ priceDateIso: "2026-06-25", latestSettledSessionIso: SETTLED }),
    ).toBe(false);
  });

  it("always reports money-market funds as current (par NAV, never fetched)", () => {
    expect(
      holdingCoversLatestClose({
        priceDateIso: "2020-01-01",
        latestSettledSessionIso: SETTLED,
        isMoneyMarket: true,
      }),
    ).toBe(true);
  });

  it("is never current when the holding has no value (no price/FX/fallback)", () => {
    expect(
      holdingCoversLatestClose({
        priceDateIso: SETTLED,
        latestSettledSessionIso: SETTLED,
        hasValue: false,
      }),
    ).toBe(false);
  });

  it("is not current when either date is missing", () => {
    expect(
      holdingCoversLatestClose({ priceDateIso: "", latestSettledSessionIso: SETTLED }),
    ).toBe(false);
    expect(
      holdingCoversLatestClose({ priceDateIso: SETTLED, latestSettledSessionIso: "" }),
    ).toBe(false);
  });
});
