/**
 * Tests for the per-holding update-status lifecycle resolver. Locale-dependent
 * time stamps are asserted loosely (non-empty) to stay portable; the structural
 * verdicts (which visual state, dots vs. check) are asserted exactly.
 */
import { describe, expect, it } from "vitest";

import {
  HOLDING_UPDATED_FLASH_MS,
  emptyHoldingStatusModel,
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
    expect(view.title).toMatch(/queued/i);
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
  it("starts with no phases and no recent updates", () => {
    const model = emptyHoldingStatusModel();
    expect(model.phases.size).toBe(0);
    expect(model.updatedAt.size).toBe(0);
  });
});
