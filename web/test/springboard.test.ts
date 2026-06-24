/**
 * Tests for the blob "springboard" deciders (`springboard.ts`): when the desktop
 * shipped its 1D/1W session in the export, the web paints straight from it (and
 * only bridges to the live tip) instead of re-fetching — covering the fresh,
 * medium-stale, and pre-market cases, and falling back (returning `null`) when
 * the export has slid out of the current window.
 *
 * Pure decision logic: `now`, the export and the tip are injected, so no DOM /
 * network / clock is touched. June 2024 is EDT (UTC−4): 09:30 ET open = 13:30Z,
 * 16:00 ET close = 20:00Z.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { LiveTip } from "../src/intraday";
import {
  parseExportedPoints,
  springboardSessionCurve,
  springboardWeekCurve,
} from "../src/springboard";
import type { ExportLiveCurvePoint, ExportLiveGraphs } from "../src/types";

const d = (v: string | number): Decimal => new Decimal(v);
const tip: LiveTip = { valueEur: d("1100"), valueUsd: d("1200") };

function pt(t: string, eur: string, usd: string): ExportLiveCurvePoint {
  return { t, value_eur: eur, value_usd: usd };
}

// A mid-session "today" (Wed 2024-06-05, 10:00 ET = 14:00Z) and its calendar.
const MID_SESSION = new Date("2024-06-05T14:00:00Z");
const TODAY = "2024-06-05";
const PREV = "2024-06-04"; // Tuesday
// Before today's 09:30 open: lastSessionDate is still yesterday's session.
const PRE_MARKET = new Date("2024-06-05T12:00:00Z");
// After today's 16:00 close.
const POST_CLOSE = new Date("2024-06-05T21:00:00Z");

function dayExport(sessionDate: string, points: ExportLiveCurvePoint[]): ExportLiveGraphs {
  return {
    captured_at: `${sessionDate}T14:00:00Z`,
    day: { session_date: sessionDate, market_open: true, points },
  };
}

function weekExport(endDate: string, points: ExportLiveCurvePoint[]): ExportLiveGraphs {
  return {
    captured_at: `${endDate}T20:00:00Z`,
    week: { start_date: PREV, end_date: endDate, market_open: false, points },
  };
}

describe("parseExportedPoints", () => {
  it("parses both currencies and sorts ascending, dropping unreadable points", () => {
    const points = parseExportedPoints([
      pt("2024-06-05T14:00:00Z", "1010", "1110"),
      pt("2024-06-05T13:35:00Z", "1000", "1100"),
      { t: "not-a-date", value_eur: "1", value_usd: "1" },
      { t: "2024-06-05T15:00:00Z", value_eur: null, value_usd: "1" },
    ]);
    expect(points.map((p) => p.t)).toEqual([
      Date.parse("2024-06-05T13:35:00Z"),
      Date.parse("2024-06-05T14:00:00Z"),
    ]);
    expect(points[0].valueEur.toString()).toBe("1000");
    expect(points[0].valueUsd.toString()).toBe("1100");
  });

  it("returns an empty list for absent points", () => {
    expect(parseExportedPoints(undefined)).toEqual([]);
    expect(parseExportedPoints([])).toEqual([]);
  });
});

describe("springboardSessionCurve", () => {
  const freshPoints = [
    pt("2024-06-05T13:35:00Z", "1000", "1100"),
    pt("2024-06-05T13:50:00Z", "1005", "1105"),
  ];

  it("springboards a fresh same-session export and bridges to the live tip at now", () => {
    const curve = springboardSessionCurve({
      exported: dayExport(TODAY, freshPoints),
      now: MID_SESSION,
      liveTip: tip,
    });
    expect(curve).not.toBeNull();
    const last = curve![curve!.length - 1];
    expect(last.t).toBe(MID_SESSION.getTime());
    expect(last.valueEur.toString()).toBe("1100");
  });

  it("still springboards a medium-stale (≈2h old) same-session export", () => {
    // Points stop ~2h before now; the tip bridges the gap rather than re-fetching.
    const stale = [
      pt("2024-06-05T11:35:00Z", "1000", "1100"),
      pt("2024-06-05T11:50:00Z", "1005", "1105"),
    ];
    const curve = springboardSessionCurve({
      exported: dayExport(TODAY, stale),
      now: MID_SESSION,
      liveTip: tip,
    });
    expect(curve).not.toBeNull();
    expect(curve![curve!.length - 1].t).toBe(MID_SESSION.getTime());
  });

  it("springboards yesterday's completed session pre-market and caps it at the close", () => {
    const curve = springboardSessionCurve({
      exported: dayExport(PREV, [
        pt("2024-06-04T13:35:00Z", "990", "1090"),
        pt("2024-06-04T19:55:00Z", "995", "1095"),
      ]),
      now: PRE_MARKET,
      liveTip: tip,
    });
    expect(curve).not.toBeNull();
    // Market shut now ⇒ the tip lands at yesterday's 16:00 ET close (20:00Z).
    expect(curve![curve!.length - 1].t).toBe(Date.parse("2024-06-04T20:00:00Z"));
  });

  it("falls back (null) when the export is yesterday's but today is live", () => {
    const curve = springboardSessionCurve({
      exported: dayExport(PREV, freshPoints),
      now: MID_SESSION,
      liveTip: tip,
    });
    expect(curve).toBeNull();
  });

  it("falls back (null) when the export only carries the session's late tail", () => {
    // Points start ~13:55 ET (17:55Z), well past the 09:30 open, so the export is
    // only a sliver of the day — the curve should rebuild live, not springboard.
    const curve = springboardSessionCurve({
      exported: dayExport(TODAY, [
        pt("2024-06-05T17:55:00Z", "1050", "1150"),
        pt("2024-06-05T17:58:00Z", "1055", "1155"),
      ]),
      now: POST_CLOSE,
      liveTip: tip,
    });
    expect(curve).toBeNull();
  });

  it("returns null when there is no day export or too few points", () => {
    expect(springboardSessionCurve({ exported: undefined, now: MID_SESSION })).toBeNull();
    expect(
      springboardSessionCurve({
        exported: dayExport(TODAY, [pt("2024-06-05T13:35:00Z", "1000", "1100")]),
        now: MID_SESSION,
        liveTip: null,
      }),
    ).toBeNull();
  });
});

describe("springboardWeekCurve", () => {
  const weekPoints = [
    pt("2024-06-03T20:00:00Z", "900", "1000"),
    pt("2024-06-04T20:00:00Z", "950", "1050"),
  ];

  it("springboards a fresh week export ending on the current session", () => {
    const curve = springboardWeekCurve({
      exported: weekExport(TODAY, [...weekPoints, pt("2024-06-05T13:50:00Z", "960", "1060")]),
      now: MID_SESSION,
      liveTip: tip,
    });
    expect(curve).not.toBeNull();
    expect(curve![curve!.length - 1].t).toBe(MID_SESSION.getTime());
  });

  it("still springboards a 1-day-stale week export (ends the previous session)", () => {
    const curve = springboardWeekCurve({
      exported: weekExport(PREV, weekPoints),
      now: MID_SESSION,
      liveTip: tip,
    });
    expect(curve).not.toBeNull();
    // Live tip supplies today's still-missing point.
    expect(curve![curve!.length - 1].t).toBe(MID_SESSION.getTime());
  });

  it("falls back (null) when the week export is ≥2 trading days stale", () => {
    const curve = springboardWeekCurve({
      exported: weekExport("2024-05-31", weekPoints),
      now: MID_SESSION,
      liveTip: tip,
    });
    expect(curve).toBeNull();
  });

  it("bridges to the last settled close when the market is shut", () => {
    const curve = springboardWeekCurve({
      exported: weekExport(TODAY, [...weekPoints, pt("2024-06-05T19:55:00Z", "960", "1060")]),
      now: POST_CLOSE,
      liveTip: tip,
    });
    expect(curve).not.toBeNull();
    expect(curve![curve!.length - 1].t).toBe(Date.parse("2024-06-05T20:00:00Z"));
  });

  it("falls back (null) when the week export only carries a single day", () => {
    // The desktop shipped only the last session within the week window. Even
    // though `end_date` is current, a one-day blob must not be trusted as a whole
    // week — the web should rebuild its own week instead.
    const curve = springboardWeekCurve({
      exported: weekExport(TODAY, [pt("2024-06-05T13:50:00Z", "960", "1060")]),
      now: MID_SESSION,
      liveTip: tip,
    });
    expect(curve).toBeNull();
  });

  it("returns null when there is no week export", () => {
    expect(springboardWeekCurve({ exported: undefined, now: MID_SESSION })).toBeNull();
    expect(springboardWeekCurve({ exported: { captured_at: "x" }, now: MID_SESSION })).toBeNull();
  });
});
