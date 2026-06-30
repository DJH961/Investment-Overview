/**
 * Tests for the per-holding update-status lifecycle resolver. Locale-dependent
 * time stamps are asserted loosely (non-empty) to stay portable; the structural
 * verdicts (which visual state, dots vs. check) are asserted exactly.
 */
import { describe, expect, it } from "vitest";

import {
  HOLDING_UPDATED_FLASH_MS,
  computeQueueEtas,
  emptyHoldingStatusModel,
  formatQueueCountdown,
  resolveHoldingStatus,
} from "../src/holding-status";
import { formatLastPull, formatUpdatedAt } from "../src/format";

const NOW = new Date("2026-06-26T16:30:00Z");
const NOW_MS = NOW.getTime();

describe("resolveHoldingStatus", () => {
  it("rests on a quiet 'Updated <time>' stamp when nothing is in flight", () => {
    const view = resolveHoldingStatus({
      asOf: NOW_MS - 5 * 60 * 1000,
      fallbackDate: "2026-06-26",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("idle");
    expect(view.label).toBe("Updated");
    expect(view.stamp).toBeTruthy();
    expect(view.dots).toBe(false);
    expect(view.check).toBe(false);
  });

  it("shows the animated 'Updating…' state with dots while a pull is live", () => {
    const view = resolveHoldingStatus({
      livePhase: "updating",
      asOf: NOW_MS,
      fallbackDate: "2026-06-26",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("updating");
    expect(view.label).toBe("Updating");
    expect(view.dots).toBe(true);
    expect(view.check).toBe(false);
    expect(view.stamp).toBeNull();
  });

  it("treats queued symbols as 'Updating…' too, but as a distinct kind", () => {
    const view = resolveHoldingStatus({
      livePhase: "queued",
      asOf: null,
      fallbackDate: "",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("queued");
    expect(view.label).toBe("Updating");
    expect(view.dots).toBe(true);
    expect(view.countdown).toBeNull();
    expect(view.title).toMatch(/queued/i);
  });

  it("counts a queued symbol down in whole seconds when an ETA is known", () => {
    const view = resolveHoldingStatus({
      livePhase: "queued",
      queueReadyAt: NOW_MS + 120_000,
      asOf: null,
      fallbackDate: "",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("queued");
    // Seconds-only, even past a minute (120, not "2:00") and dots give way to it.
    expect(view.countdown).toBe("120");
    expect(view.dots).toBe(false);
    expect(view.title).toMatch(/120s/);
  });

  it("drops the countdown (back to dots) once a queued ETA has elapsed", () => {
    const view = resolveHoldingStatus({
      livePhase: "queued",
      queueReadyAt: NOW_MS - 1,
      asOf: null,
      fallbackDate: "",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("queued");
    expect(view.countdown).toBeNull();
    expect(view.dots).toBe(true);
  });

  it("flashes 'Updated ✓' for a symbol pulled within the flash window", () => {
    const view = resolveHoldingStatus({
      asOf: NOW_MS,
      fallbackDate: "2026-06-26",
      updatedAt: NOW_MS - 500,
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("updated");
    expect(view.label).toBe("Updated");
    expect(view.check).toBe(true);
    expect(view.dots).toBe(false);
  });

  it("settles back to the quiet stamp once the flash window elapses", () => {
    const view = resolveHoldingStatus({
      asOf: NOW_MS,
      fallbackDate: "2026-06-26",
      updatedAt: NOW_MS - (HOLDING_UPDATED_FLASH_MS + 1),
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("idle");
    expect(view.check).toBe(false);
  });

  it("lets a live phase win over a recent updatedAt flash", () => {
    const view = resolveHoldingStatus({
      livePhase: "updating",
      asOf: NOW_MS,
      fallbackDate: "2026-06-26",
      updatedAt: NOW_MS - 200,
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("updating");
  });

  it("never flashes for a future / negative-age updatedAt", () => {
    const view = resolveHoldingStatus({
      asOf: NOW_MS,
      fallbackDate: "2026-06-26",
      updatedAt: NOW_MS + 5_000,
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("idle");
  });

  it("stamps the idle caption with the pull time, not the price's strike time", () => {
    // The price was struck an hour ago but only pulled five minutes ago — the
    // caption must say when we pulled, so it reflects the recent refresh.
    const struckAt = NOW_MS - 60 * 60 * 1000;
    const pulledAt = NOW_MS - 5 * 60 * 1000;
    const view = resolveHoldingStatus({
      asOf: struckAt,
      pulledAt,
      fallbackDate: "2026-06-26",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("idle");
    expect(view.stamp).toBe(formatUpdatedAt(pulledAt, "2026-06-26", NOW));
    expect(view.stamp).not.toBe(formatUpdatedAt(struckAt, "2026-06-26", NOW));
    expect(view.title).toContain(formatLastPull(pulledAt, NOW));
  });

  it("falls back to the strike time when no pull time is known", () => {
    const struckAt = NOW_MS - 60 * 60 * 1000;
    const view = resolveHoldingStatus({
      asOf: struckAt,
      fallbackDate: "2026-06-26",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.stamp).toBe(formatUpdatedAt(struckAt, "2026-06-26", NOW));
  });

  it("falls back to the value-date stamp when no observation time exists", () => {
    const view = resolveHoldingStatus({
      asOf: null,
      fallbackDate: "2026-06-20",
      nowMs: NOW_MS,
      now: NOW,
    });
    expect(view.kind).toBe("idle");
    expect(view.stamp).toBeTruthy();
  });
});

describe("emptyHoldingStatusModel", () => {
  it("starts with no phases, no recent updates, and no queue ETAs", () => {
    const model = emptyHoldingStatusModel();
    expect(model.phases.size).toBe(0);
    expect(model.updatedAt.size).toBe(0);
    expect(model.queueReadyAt.size).toBe(0);
  });
});

describe("formatQueueCountdown", () => {
  it("renders whole seconds, rounding up, never below zero", () => {
    expect(formatQueueCountdown(120_000)).toBe("120");
    expect(formatQueueCountdown(118_400)).toBe("119"); // rounds up
    expect(formatQueueCountdown(900)).toBe("1"); // final sub-second tick
    expect(formatQueueCountdown(0)).toBe("0");
    expect(formatQueueCountdown(-5_000)).toBe("0");
  });
});

describe("computeQueueEtas", () => {
  const ANCHOR = 1_000_000;
  const ROUND = 60_000;

  it("places the first deferred symbol in the very next round (the user's 13/#10 case)", () => {
    // 13 symbols, capacity 8: the first 8 fetched this (now-completed) round, the
    // rest deferred. Those 8 are done, so the first deferred symbol rides the very
    // next round (~1 min) and — since 5 ≤ capacity — so do all five.
    const fetched = Array.from({ length: 8 }, (_, i) => `F${i}`);
    const deferred = ["D9", "D10", "D11", "D12", "D13"]; // overall positions 9–13
    const etas = computeQueueEtas({
      fetched,
      deferred,
      capacityPerRound: 8,
      anchorMs: ANCHOR,
      roundIntervalMs: ROUND,
    });
    // Deferred index 0 (D9) → round floor(0/8)+1 = 1; index 1 (D10) → round 1.
    expect(etas.get("D9")).toBe(ANCHOR + 1 * ROUND);
    expect(etas.get("D10")).toBe(ANCHOR + 1 * ROUND);
    expect(etas.get("D13")).toBe(ANCHOR + 1 * ROUND);
  });

  it("does not let the already-fetched count push deferred ETAs out a round", () => {
    // Regression guard: a full current round (capacity fetched) must not bump the
    // first deferred symbol from round 1 (~1 min) to round 2 (~2 min).
    const etas = computeQueueEtas({
      fetched: Array.from({ length: 8 }, (_, i) => `F${i}`),
      deferred: ["D0"],
      capacityPerRound: 8,
      anchorMs: ANCHOR,
      roundIntervalMs: ROUND,
    });
    expect(etas.get("D0")).toBe(ANCHOR + 1 * ROUND);
  });

  it("fans a deep queue across as many rounds as the capacity demands", () => {
    const fetched: string[] = []; // nothing fetched yet this round
    const deferred = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const etas = computeQueueEtas({
      fetched,
      deferred,
      capacityPerRound: 8,
      anchorMs: ANCHOR,
      roundIntervalMs: ROUND,
    });
    expect(etas.get("S0")).toBe(ANCHOR + 1 * ROUND); // first round
    expect(etas.get("S7")).toBe(ANCHOR + 1 * ROUND);
    expect(etas.get("S8")).toBe(ANCHOR + 2 * ROUND); // second round
    expect(etas.get("S16")).toBe(ANCHOR + 3 * ROUND); // third round
  });

  it("guards against a non-positive capacity", () => {
    const etas = computeQueueEtas({
      fetched: [],
      deferred: ["A", "B"],
      capacityPerRound: 0,
      anchorMs: ANCHOR,
      roundIntervalMs: ROUND,
    });
    // Capacity floored to 1: one symbol per round.
    expect(etas.get("A")).toBe(ANCHOR + 1 * ROUND);
    expect(etas.get("B")).toBe(ANCHOR + 2 * ROUND);
  });
});
