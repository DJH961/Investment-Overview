import { describe, expect, it, vi } from "vitest";

import { Decimal } from "../src/decimal-config";
import {
  AGREEMENTS_TO_SETTLE,
  closeProbeReady,
  nextFullHourStart,
  resolveCloseCompleteness,
  PROBE_MIN_MS,
} from "../src/close-completeness";
import type { Bar } from "../src/timeseries";
import type { StoredCloseProbe } from "../src/timeseries-store";

const bar = (t: number, value = "1"): Bar => ({ t, value: new Decimal(value) });

describe("nextFullHourStart", () => {
  it("rounds a mid-hour instant up to the start of the next full hour", () => {
    const t = Date.parse("2026-06-23T15:48:00Z");
    expect(nextFullHourStart(t)).toBe(Date.parse("2026-06-23T16:00:00Z"));
  });

  it("an instant exactly on the hour advances to the following hour", () => {
    const t = Date.parse("2026-06-23T16:00:00Z");
    expect(nextFullHourStart(t)).toBe(Date.parse("2026-06-23T17:00:00Z"));
  });
});

describe("closeProbeReady", () => {
  const at = (iso: string): number => Date.parse(iso);
  const provisionalAgreement = (lastAttemptAt: number): StoredCloseProbe => ({
    lastBarAt: 0,
    attempts: 1,
    sources: 2,
    settled: false,
    lastAttemptAt,
    agreements: 1,
  });

  it("an absent probe is always ready", () => {
    expect(closeProbeReady(undefined, 0, PROBE_MIN_MS)).toBe(true);
  });

  it("a provisional two-source agreement is paced to the next full hour, not probeMinMs", () => {
    const probe = provisionalAgreement(at("2026-06-23T15:48:00Z"));
    // 10 min later (well past PROBE_MIN_MS) but before the hour boundary ⇒ not ready.
    expect(closeProbeReady(probe, at("2026-06-23T15:58:00Z"), PROBE_MIN_MS)).toBe(false);
    // At the top of the next hour ⇒ ready (an app that only opens at 16:08 still qualifies).
    expect(closeProbeReady(probe, at("2026-06-23T16:00:00Z"), PROBE_MIN_MS)).toBe(true);
    expect(closeProbeReady(probe, at("2026-06-23T16:08:00Z"), PROBE_MIN_MS)).toBe(true);
  });

  it("a single-source / outage probe uses the flat probeMinMs window", () => {
    const probe: StoredCloseProbe = {
      lastBarAt: 0,
      attempts: 1,
      sources: 1,
      settled: false,
      lastAttemptAt: 1_000_000,
    };
    expect(closeProbeReady(probe, 1_000_000 + PROBE_MIN_MS - 1, PROBE_MIN_MS)).toBe(false);
    expect(closeProbeReady(probe, 1_000_000 + PROBE_MIN_MS, PROBE_MIN_MS)).toBe(true);
  });
});

describe("resolveCloseCompleteness — two-step agreement", () => {
  const CLOSE = Date.parse("2026-06-23T20:00:00Z");
  const TIP = Date.parse("2026-06-23T18:00:00Z"); // short of the close
  const tol = 5 * 60 * 1000;

  function runAgreement(prevAgreements: number | undefined): Promise<{
    settled: boolean;
    sources: number;
    agreements?: number;
  }> {
    const probe: StoredCloseProbe | undefined =
      prevAgreements === undefined
        ? undefined
        : {
            lastBarAt: TIP,
            attempts: prevAgreements,
            sources: 2,
            settled: false,
            lastAttemptAt: 0,
            agreements: prevAgreements,
          };
    return resolveCloseCompleteness({
      symbols: ["DAX"],
      storedBars: { DAX: [bar(TIP)] },
      probes: probe ? { DAX: probe } : undefined,
      closeMs: CLOSE,
      tol,
      clampBars: (b) => b,
      fetchPrimary: async () => new Map([["DAX", [bar(TIP)]]]),
      fetchSecondary: async () => new Map([["DAX", [bar(TIP)]]]), // agrees
      now: 1,
      label: "1D",
    }).then((res) => {
      const p = res.closeProbe.DAX;
      return { settled: p.settled, sources: p.sources, agreements: p.agreements };
    });
  }

  it("the first agreement is provisional (sources:2, settled:false, agreements:1)", async () => {
    expect(await runAgreement(undefined)).toEqual({ settled: false, sources: 2, agreements: 1 });
  });

  it("settles exactly on the AGREEMENTS_TO_SETTLE-th agreement", async () => {
    expect(await runAgreement(AGREEMENTS_TO_SETTLE - 2)).toMatchObject({ settled: false });
    expect(await runAgreement(AGREEMENTS_TO_SETTLE - 1)).toEqual({
      settled: true,
      sources: 2,
      agreements: AGREEMENTS_TO_SETTLE,
    });
  });

  it("a progression between agreements resets the counter (no carried agreements)", async () => {
    const LATER = TIP + 30 * 60 * 1000; // primary advances past prevTip + tol
    const res = await resolveCloseCompleteness({
      symbols: ["DAX"],
      storedBars: { DAX: [bar(TIP)] },
      probes: {
        DAX: { lastBarAt: TIP, attempts: 2, sources: 2, settled: false, lastAttemptAt: 0, agreements: 2 },
      },
      closeMs: CLOSE,
      tol,
      clampBars: (b) => b,
      fetchPrimary: async () => new Map([["DAX", [bar(LATER)]]]),
      fetchSecondary: vi.fn(async () => new Map<string, Bar[]>()),
      now: 1,
      label: "1D",
    });
    // Primary advanced ⇒ progressed (sources:1) and the agreement count is dropped.
    expect(res.closeProbe.DAX.sources).toBe(1);
    expect(res.closeProbe.DAX.settled).toBe(false);
    expect(res.closeProbe.DAX.agreements).toBeUndefined();
  });
});
