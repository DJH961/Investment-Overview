/**
 * Tests for the FX-across-the-market-boundary helpers (`session-fx.ts`): which
 * rate the live 1D/1W graphs anchor to, and how today's FX effect splits into its
 * market-hours and overnight slices. Pure maths — no DOM, no storage (the two
 * localStorage helpers are exercised separately with a stubbed global).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Decimal } from "../src/decimal-config";
import {
  fxEffectSplit,
  graphAnchorFx,
  readSessionCloseFx,
  readSessionOpenFx,
  recordSessionCloseFx,
  recordSessionOpenFx,
  sessionBarsComplete,
  sessionCloseFxFromBars,
  sessionFxBarsComplete,
  sessionOpenFxFromBars,
} from "../src/session-fx";

const d = (v: string | number): Decimal => new Decimal(v);

describe("graphAnchorFx", () => {
  it("uses the live rate while the market is open", () => {
    const fx = graphAnchorFx({ marketOpen: true, liveFx: d("1.08"), sessionCloseFx: d("1.05") });
    expect(fx?.toString()).toBe("1.08");
  });

  it("freezes to the session-close rate once the market is shut", () => {
    const fx = graphAnchorFx({ marketOpen: false, liveFx: d("1.08"), sessionCloseFx: d("1.05") });
    expect(fx?.toString()).toBe("1.05");
  });

  it("falls back to the live rate when no close rate is known (closed)", () => {
    const fx = graphAnchorFx({ marketOpen: false, liveFx: d("1.08"), sessionCloseFx: null });
    expect(fx?.toString()).toBe("1.08");
  });

  it("freezes to the settled previous close when no live close was captured", () => {
    // App was not live at 16:00 ET / cold start: no captured session close, but
    // the settled previousClose is a stable rate the curve can freeze to instead
    // of sliding with the live after-hours spot.
    const fx = graphAnchorFx({
      marketOpen: false,
      liveFx: d("1.08"),
      sessionCloseFx: null,
      settledPrevFx: d("1.0725"),
    });
    expect(fx?.toString()).toBe("1.0725");
  });

  it("prefers the live-captured close over the settled previous close", () => {
    const fx = graphAnchorFx({
      marketOpen: false,
      liveFx: d("1.08"),
      sessionCloseFx: d("1.0775"),
      settledPrevFx: d("1.0725"),
    });
    expect(fx?.toString()).toBe("1.0775");
  });

  it("ignores a non-positive settled previous close and uses the live rate", () => {
    const fx = graphAnchorFx({
      marketOpen: false,
      liveFx: d("1.08"),
      sessionCloseFx: null,
      settledPrevFx: d("0"),
    });
    expect(fx?.toString()).toBe("1.08");
  });

  it("keeps using the live rate while open even if a settled prev is supplied", () => {
    const fx = graphAnchorFx({
      marketOpen: true,
      liveFx: d("1.08"),
      sessionCloseFx: d("1.05"),
      settledPrevFx: d("1.0725"),
    });
    expect(fx?.toString()).toBe("1.08");
  });

  it("returns null when neither rate is available", () => {
    expect(graphAnchorFx({ marketOpen: false, liveFx: null, sessionCloseFx: null })).toBeNull();
  });
});

describe("sessionCloseFxFromBars", () => {
  const closeMs = 1_000_000;
  const bar = (t: number, value: string) => ({ t, value: d(value) });

  it("returns the latest bar at or before the session close", () => {
    const bars = [bar(closeMs - 7200_000, "1.07"), bar(closeMs - 3600_000, "1.0750"), bar(closeMs, "1.0775")];
    expect(sessionCloseFxFromBars(bars, closeMs)?.toString()).toBe("1.0775");
  });

  it("ignores after-hours bars past the close (the drift the freeze excludes)", () => {
    const bars = [bar(closeMs - 3600_000, "1.0750"), bar(closeMs, "1.0775"), bar(closeMs + 3600_000, "1.09")];
    expect(sessionCloseFxFromBars(bars, closeMs)?.toString()).toBe("1.0775");
  });

  it("tolerates unsorted bars", () => {
    const bars = [bar(closeMs, "1.0775"), bar(closeMs - 7200_000, "1.07"), bar(closeMs - 3600_000, "1.0750")];
    expect(sessionCloseFxFromBars(bars, closeMs)?.toString()).toBe("1.0775");
  });

  it("skips non-positive bar values", () => {
    const bars = [bar(closeMs - 3600_000, "1.0750"), bar(closeMs, "0")];
    expect(sessionCloseFxFromBars(bars, closeMs)?.toString()).toBe("1.075");
  });

  it("returns null when no bar settled by the close (empty / all after-hours)", () => {
    expect(sessionCloseFxFromBars([], closeMs)).toBeNull();
    expect(sessionCloseFxFromBars([bar(closeMs + 60_000, "1.09")], closeMs)).toBeNull();
  });
});

describe("sessionOpenFxFromBars", () => {
  const openMs = 1_000_000;
  const bar = (t: number, value: string) => ({ t, value: d(value) });

  it("returns the earliest bar at or after the session open", () => {
    const bars = [bar(openMs, "1.0900"), bar(openMs + 3600_000, "1.0875"), bar(openMs + 7200_000, "1.085")];
    expect(sessionOpenFxFromBars(bars, openMs)?.toString()).toBe("1.09");
  });

  it("ignores pre-market bars before the open", () => {
    const bars = [bar(openMs - 3600_000, "1.10"), bar(openMs, "1.0900"), bar(openMs + 3600_000, "1.0875")];
    expect(sessionOpenFxFromBars(bars, openMs)?.toString()).toBe("1.09");
  });

  it("tolerates unsorted bars", () => {
    const bars = [bar(openMs + 7200_000, "1.085"), bar(openMs, "1.0900"), bar(openMs + 3600_000, "1.0875")];
    expect(sessionOpenFxFromBars(bars, openMs)?.toString()).toBe("1.09");
  });

  it("skips non-positive bar values", () => {
    const bars = [bar(openMs, "0"), bar(openMs + 3600_000, "1.0875")];
    expect(sessionOpenFxFromBars(bars, openMs)?.toString()).toBe("1.0875");
  });

  it("returns null when no bar printed at/after the open (empty / all pre-market)", () => {
    expect(sessionOpenFxFromBars([], openMs)).toBeNull();
    expect(sessionOpenFxFromBars([bar(openMs - 60_000, "1.09")], openMs)).toBeNull();
  });
});

describe("sessionFxBarsComplete", () => {
  const closeMs = 1_000_000;
  const bar = (t: number, value: string) => ({ t, value: d(value) });

  it("is complete when a positive bar lands exactly on the close", () => {
    const bars = [bar(closeMs - 3600_000, "1.0750"), bar(closeMs, "1.0775")];
    expect(sessionFxBarsComplete(bars, closeMs)).toBe(true);
  });

  it("is complete when a positive after-hours bar exists past the close", () => {
    // EUR/USD trades after the equity close, so a track fetched once the session
    // shut always carries a bar at/after the close — the genuine-settle signal.
    const bars = [bar(closeMs - 3600_000, "1.0750"), bar(closeMs + 3600_000, "1.09")];
    expect(sessionFxBarsComplete(bars, closeMs)).toBe(true);
  });

  it("is incomplete when every bar stops short of the close (mid-session fetch)", () => {
    const bars = [bar(closeMs - 7200_000, "1.07"), bar(closeMs - 3600_000, "1.0750")];
    expect(sessionFxBarsComplete(bars, closeMs)).toBe(false);
  });

  it("is incomplete for an empty track", () => {
    expect(sessionFxBarsComplete([], closeMs)).toBe(false);
  });

  it("ignores a non-positive bar at the close (still incomplete)", () => {
    expect(sessionFxBarsComplete([bar(closeMs, "0")], closeMs)).toBe(false);
  });
});

describe("sessionBarsComplete (price tail)", () => {
  const closeMs = 1_000_000;
  const intervalMs = 3600_000; // one bar interval of slack
  const bar = (t: number, value: string) => ({ t, value: d(value) });

  it("is complete when the newest bar lands within one interval before the close", () => {
    // The equity feed stops at the close, so a full session's last bar sits just
    // shy of 16:00 ET — within a bar interval counts as complete.
    const bars = [bar(closeMs - 7200_000, "100"), bar(closeMs - 300_000, "110")];
    expect(sessionBarsComplete(bars, closeMs, intervalMs)).toBe(true);
  });

  it("is complete when a bar lands exactly one interval before the close (inclusive)", () => {
    expect(sessionBarsComplete([bar(closeMs - intervalMs, "100")], closeMs, intervalMs)).toBe(true);
  });

  it("is incomplete when the newest bar is more than one interval short (stale partial)", () => {
    // A mid-session fetch (e.g. at 14:00) whose tail never reached the close —
    // scenario F: must read incomplete so the after-close backfill re-pulls it.
    const bars = [bar(closeMs - 10800_000, "100"), bar(closeMs - 7200_000, "105")];
    expect(sessionBarsComplete(bars, closeMs, intervalMs)).toBe(false);
  });

  it("is incomplete for an empty track", () => {
    expect(sessionBarsComplete([], closeMs, intervalMs)).toBe(false);
  });
});

describe("fxEffectSplit", () => {
  it("falls the whole move into the live leg while open with no session-open anchor", () => {
    // Without a session-open FX anchor the live market-hours leg cannot be carved,
    // so the whole move lands in market hours and the frozen overnight leg is null
    // (so the UI hides the split rather than inventing a zero counterpart).
    const split = fxEffectSplit({
      marketOpen: true,
      totalValueUsd: d("108000"),
      liveFx: d("1.08"),
      sessionCloseFx: null,
      todayFxMoveEur: d("120"),
    });
    expect(split.totalEur?.toString()).toBe("120");
    expect(split.overnightEur).toBeNull();
    expect(split.marketHoursEur?.toString()).toBe("120");
  });

  it("carves the live market-hours leg from the open and keeps last night's overnight", () => {
    // USD book $108,000. Opened at 1.09 → €99,082.57; live now 1.08 → €100,000.
    // Live market-hours slice = €100,000 − €99,082.57 = +€917.43 (since the open).
    // Overnight (last night, frozen) = whole move − market hours = remainder.
    const split = fxEffectSplit({
      marketOpen: true,
      totalValueUsd: d("108000"),
      liveFx: d("1.08"),
      sessionCloseFx: null,
      sessionOpenFx: d("1.09"),
      todayFxMoveEur: d("1200"),
    });
    expect(split.totalEur?.toString()).toBe("1200");
    expect(split.marketHoursEur).not.toBeNull();
    expect(split.marketHoursEur!.toNumber()).toBeCloseTo(917.431, 2);
    expect(split.overnightEur).not.toBeNull();
    // Two legs sum to the whole move so last night's slice survives the open.
    expect(split.marketHoursEur!.plus(split.overnightEur!).toNumber()).toBeCloseTo(1200, 6);
    expect(split.overnightEur!.toNumber()).toBeCloseTo(282.569, 2);
  });

  it("isolates the overnight FX drift once the market is shut", () => {
    // USD book of $108,000. Closed at 1.08 → €100,000; live now 1.10 → €98,181.82.
    // Overnight slice = €98,181.82 − €100,000 = −€1,818.18 (euro strengthened).
    const split = fxEffectSplit({
      marketOpen: false,
      totalValueUsd: d("108000"),
      liveFx: d("1.10"),
      sessionCloseFx: d("1.08"),
      todayFxMoveEur: d("-1500"),
    });
    expect(split.overnightEur).not.toBeNull();
    expect(split.overnightEur!.toNumber()).toBeCloseTo(-1818.1818, 3);
    // Market-hours slice is the remainder of the day's FX move.
    expect(split.marketHoursEur!.toNumber()).toBeCloseTo(-1500 - -1818.1818, 3);
  });

  it("overnight slice is positive when the euro weakens after the close", () => {
    // Euro weakens (rate up to ... no): live rate LOWER than close ⇒ each USD buys
    // back MORE euros ⇒ EUR value rises ⇒ positive overnight slice.
    const split = fxEffectSplit({
      marketOpen: false,
      totalValueUsd: d("108000"),
      liveFx: d("1.06"),
      sessionCloseFx: d("1.08"),
      todayFxMoveEur: d("0"),
    });
    expect(split.overnightEur!.toNumber()).toBeGreaterThan(0);
  });

  it("returns nulls when USD exposure or the rate pair is missing (closed)", () => {
    const noUsd = fxEffectSplit({
      marketOpen: false,
      totalValueUsd: null,
      liveFx: d("1.08"),
      sessionCloseFx: d("1.05"),
      todayFxMoveEur: d("50"),
    });
    expect(noUsd.overnightEur).toBeNull();
    // marketHours falls back to the whole move when overnight is unknown.
    expect(noUsd.marketHoursEur?.toString()).toBe("50");

    const noClose = fxEffectSplit({
      marketOpen: false,
      totalValueUsd: d("108000"),
      liveFx: d("1.08"),
      sessionCloseFx: null,
      todayFxMoveEur: d("50"),
    });
    expect(noClose.overnightEur).toBeNull();
  });

  it("propagates a null FX move as a null total", () => {
    const split = fxEffectSplit({
      marketOpen: false,
      totalValueUsd: d("108000"),
      liveFx: d("1.08"),
      sessionCloseFx: d("1.05"),
      todayFxMoveEur: null,
    });
    expect(split.totalEur).toBeNull();
    expect(split.marketHoursEur).toBeNull();
  });
});

describe("session-close FX persistence", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the rate for the same session day", () => {
    recordSessionCloseFx("2026-06-25", d("1.0834"));
    expect(readSessionCloseFx("2026-06-25")?.toString()).toBe("1.0834");
  });

  it("ignores a rate captured for a different session", () => {
    recordSessionCloseFx("2026-06-24", d("1.07"));
    expect(readSessionCloseFx("2026-06-25")).toBeNull();
  });

  it("does not store a null or non-positive rate", () => {
    recordSessionCloseFx("2026-06-25", null);
    expect(readSessionCloseFx("2026-06-25")).toBeNull();
    recordSessionCloseFx("2026-06-25", d("0"));
    expect(readSessionCloseFx("2026-06-25")).toBeNull();
  });

  it("returns null (not throw) when nothing is stored", () => {
    expect(readSessionCloseFx("2026-06-25")).toBeNull();
  });
});

describe("session-open FX persistence", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the first-seen rate for the same session day", () => {
    recordSessionOpenFx("2026-06-25", d("1.0834"));
    expect(readSessionOpenFx("2026-06-25")?.toString()).toBe("1.0834");
  });

  it("keeps the earliest capture and never overwrites it with a later spot", () => {
    recordSessionOpenFx("2026-06-25", d("1.0834"));
    recordSessionOpenFx("2026-06-25", d("1.0900"));
    expect(readSessionOpenFx("2026-06-25")?.toString()).toBe("1.0834");
  });

  it("ignores a rate captured for a different session", () => {
    recordSessionOpenFx("2026-06-24", d("1.07"));
    expect(readSessionOpenFx("2026-06-25")).toBeNull();
  });

  it("starts a fresh capture once the session day rolls over", () => {
    recordSessionOpenFx("2026-06-24", d("1.07"));
    recordSessionOpenFx("2026-06-25", d("1.0834"));
    expect(readSessionOpenFx("2026-06-25")?.toString()).toBe("1.0834");
  });

  it("does not store a null or non-positive rate", () => {
    recordSessionOpenFx("2026-06-25", null);
    expect(readSessionOpenFx("2026-06-25")).toBeNull();
    recordSessionOpenFx("2026-06-25", d("0"));
    expect(readSessionOpenFx("2026-06-25")).toBeNull();
  });

  it("returns null (not throw) when nothing is stored", () => {
    expect(readSessionOpenFx("2026-06-25")).toBeNull();
  });
});
