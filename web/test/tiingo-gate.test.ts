/**
 * Tests for the pure Tiingo-fallback decision core (`tiingo-gate.ts`) — the
 * browser mirror of the desktop `services/tiingo_fallback.py`. No I/O, so every
 * gate is exercised directly with explicit inputs.
 */
import { describe, expect, it } from "vitest";

import {
  Budget,
  decideNav,
  etMinutesOfDay,
  firstProbeMinutes,
  marketSymbolEligible,
  navCooldownFor,
  selectWithinBudget,
  NAV_PROBE_COOLDOWN_MS,
  NAV_FIRST_PROBE_FLOOR_MIN,
  NAV_MAX_PROBES_PER_DAY,
  WEB_DAILY_CAP,
  WEB_HOURLY_CAP,
} from "../src/tiingo-gate";

/** Build an epoch for a given ET wall-clock time on a fixed weekday (Mon). */
function etEpoch(hour: number, minute: number): number {
  // 2026-06-22 is a Monday. ET is UTC-4 in June (EDT), so add 4h to get UTC.
  return Date.UTC(2026, 5, 22, hour + 4, minute, 0);
}

describe("Budget", () => {
  it("remaining is the tighter of hour/day caps and never negative", () => {
    expect(new Budget(0, 0).remaining()).toBe(WEB_HOURLY_CAP);
    expect(new Budget(WEB_HOURLY_CAP, 0).remaining()).toBe(0);
    expect(new Budget(0, WEB_DAILY_CAP).remaining()).toBe(0);
    expect(new Budget(100, 0).remaining()).toBe(0);
    expect(new Budget(5, 0).hasRoom()).toBe(true);
  });

  it("clamps a negative used count so an over-refund can't exceed the cap", () => {
    // A negative net spend (more refunded than taken in the window) must not make
    // `cap - used` exceed the cap and hand out phantom headroom.
    expect(new Budget(-5, 0).remaining()).toBe(WEB_HOURLY_CAP);
    expect(new Budget(0, -10).remaining()).toBe(WEB_HOURLY_CAP);
    expect(new Budget(-5, -10).remaining()).toBe(WEB_HOURLY_CAP);
  });
});

describe("selectWithinBudget", () => {
  it("trims to the remaining allowance", () => {
    expect(selectWithinBudget(["a", "b", "c"], new Budget(WEB_HOURLY_CAP - 2, 0))).toEqual(["a", "b"]);
    expect(selectWithinBudget(["a", "b"], new Budget(WEB_HOURLY_CAP, 0))).toEqual([]);
  });
});

describe("marketSymbolEligible", () => {
  it("is eligible only when newer data actually exists", () => {
    // Behind the settled session → worth a call.
    expect(marketSymbolEligible({ heldDate: "2026-06-20", expectedDate: "2026-06-22", primaryFailed: true })).toBe(true);
    // Hold nothing → worth a call.
    expect(marketSymbolEligible({ heldDate: null, expectedDate: "2026-06-22", primaryFailed: false })).toBe(true);
    // Already hold the latest settled session, even if the primary errored → skip.
    expect(marketSymbolEligible({ heldDate: "2026-06-22", expectedDate: "2026-06-22", primaryFailed: true })).toBe(false);
    // Up to date and primary fine → skip.
    expect(marketSymbolEligible({ heldDate: "2026-06-22", expectedDate: "2026-06-22", primaryFailed: false })).toBe(false);
  });
});

describe("navCooldownFor / firstProbeMinutes", () => {
  it("is a single flat cooldown now the posting window is deprecated", () => {
    // Inside or outside the old 17:30–19:00 window, the cooldown is identical.
    expect(navCooldownFor(18 * 60)).toBe(NAV_PROBE_COOLDOWN_MS); // 18:00 ET
    expect(navCooldownFor(20 * 60)).toBe(NAV_PROBE_COOLDOWN_MS); // 20:00 ET
  });
  it("first probe lands ~15 min past the floor with no learned habit", () => {
    expect(firstProbeMinutes(null)).toBe(NAV_FIRST_PROBE_FLOOR_MIN + 15);
    // A later learned habit pushes the first probe out.
    expect(firstProbeMinutes(18 * 60)).toBe(18 * 60 + 15);
  });
});

describe("etMinutesOfDay", () => {
  it("reads the Eastern wall clock", () => {
    expect(etMinutesOfDay(etEpoch(17, 45))).toBe(17 * 60 + 45);
  });
});

describe("decideNav — tiers", () => {
  const base = {
    canaryPick: "FSKAX",
    earliestHabitMin: null,
    lastCanaryAt: null,
    canaryCountToday: 0,
    budget: new Budget(0, 0),
  };

  it("waits when there are no missing funds", () => {
    const d = decideNav({ ...base, missingFunds: [], peerPublished: false, peerPublishedAt: null, now: etEpoch(18, 0) });
    expect(d.action).toBe("wait");
  });

  it("Tier 1: fetches laggards once the peer-trickle grace has elapsed", () => {
    const now = etEpoch(18, 30);
    const d = decideNav({
      ...base,
      missingFunds: ["FSKAX", "FXAIX"],
      peerPublished: true,
      peerPublishedAt: now - 31 * 60 * 1000, // > 30 min ago
      now,
    });
    expect(d.action).toBe("fetch_laggards");
    expect(d.symbols).toEqual(["FSKAX", "FXAIX"]);
  });

  it("Tier 1: waits inside the peer-trickle grace", () => {
    const now = etEpoch(18, 30);
    const d = decideNav({
      ...base,
      missingFunds: ["FSKAX"],
      peerPublished: true,
      peerPublishedAt: now - 5 * 60 * 1000, // 5 min ago
      now,
    });
    expect(d.action).toBe("wait");
  });

  it("Tier 2: probes a single canary when no peer evidence and past first-probe time", () => {
    const d = decideNav({
      ...base,
      missingFunds: ["FSKAX", "FXAIX"],
      peerPublished: false,
      peerPublishedAt: null,
      now: etEpoch(17, 50), // past 17:45 first probe
    });
    expect(d.action).toBe("canary");
    expect(d.symbols).toEqual(["FSKAX"]);
  });

  it("Tier 2: waits before the first-probe time", () => {
    const d = decideNav({
      ...base,
      missingFunds: ["FSKAX"],
      peerPublished: false,
      peerPublishedAt: null,
      now: etEpoch(17, 0), // before 17:45
    });
    expect(d.action).toBe("wait");
    expect(d.reason).toContain("first-probe");
  });

  it("Tier 2: respects the cooldown between probes", () => {
    const now = etEpoch(18, 0);
    const d = decideNav({
      ...base,
      missingFunds: ["FSKAX"],
      peerPublished: false,
      peerPublishedAt: null,
      lastCanaryAt: now - 5 * 60 * 1000, // within 15-min in-window cooldown
      now,
    });
    expect(d.action).toBe("wait");
    expect(d.reason).toContain("cooldown");
  });

  it("Tier 2: honours the daily probe cap", () => {
    const d = decideNav({
      ...base,
      missingFunds: ["FSKAX"],
      peerPublished: false,
      peerPublishedAt: null,
      canaryCountToday: NAV_MAX_PROBES_PER_DAY,
      now: etEpoch(18, 0),
    });
    expect(d.action).toBe("wait");
    expect(d.reason).toContain("cap");
  });

  it("waits when the budget is exhausted regardless of tier", () => {
    const d = decideNav({
      ...base,
      budget: new Budget(WEB_HOURLY_CAP, 0),
      missingFunds: ["FSKAX"],
      peerPublished: true,
      peerPublishedAt: null,
      now: etEpoch(18, 0),
    });
    expect(d.action).toBe("wait");
    expect(d.reason).toContain("budget");
  });
});
