/**
 * Per-holding "update status" lifecycle (the faint caption at the bottom-right of
 * each holding card). It narrates, per position, where its price is in the
 * refresh cycle so a glance tells you which holdings are pulling and which have
 * already landed — and *when* each last landed.
 *
 * The cycle, mirrored visually by {@link resolveHoldingStatus}:
 *
 *   "Updated <time>"  ──(round starts)──▶  "Updating…"  (live pull OR queued)
 *        ▲                                      │
 *        │ (settle animation)                   │ (fresh price lands)
 *        └────────  "Updated ✓"  ◀──────────────┘
 *
 * The view layer ({@link renderStatusContent} in ui.ts) turns these calm,
 * data-only descriptors into DOM + CSS animation, and the App drives the live
 * `updating`/`queued`/`updatedAt` signals from each refresh round. Keeping the
 * decision here (free of the DOM) lets it be unit-tested directly.
 */

import { formatLastPull, formatUpdatedAt } from "./format";

/**
 * How long a freshly-pulled holding shows its "Updated ✓" success flash before it
 * settles back into the quiet "Updated <time>" stamp. Long enough for the check
 * to register and the settle animation to play, short enough to stay calm.
 */
export const HOLDING_UPDATED_FLASH_MS = 2000;

/** A live, in-flight phase the App asserts during a refresh round. */
export type HoldingLivePhase = "updating" | "queued";

/** The resolved visual state of a holding's status caption. */
export type HoldingStatusKind = "idle" | "updating" | "queued" | "updated";

export interface HoldingStatusView {
  /** Which of the four visual states to paint. */
  kind: HoldingStatusKind;
  /** Leading text — "Updated" or "Updating". */
  label: string;
  /** The time stamp suffix shown only in the quiet `idle` state (e.g. "14:32"). */
  stamp: string | null;
  /** Whether to paint the animated "thinking" dots (updating / queued). */
  dots: boolean;
  /** Whether to paint the success check mark (the `updated` flash). */
  check: boolean;
  /**
   * A live countdown to when a *queued* (free-tier deferred) holding is expected
   * to update, e.g. `"2:00"`. Null in every other state — and also while queued
   * when no ETA is known — in which case the animated dots stand in instead.
   */
  countdown: string | null;
  /** Full tooltip naming the exact moment / what's happening. */
  title: string;
}

export interface ResolveHoldingStatusInput {
  /** A live phase asserted by the App for this round, if any. */
  livePhase?: HoldingLivePhase | null;
  /**
   * Epoch ms a *queued* holding is expected to update (its place in the
   * free-tier pull queue, resolved by {@link computeQueueEtas}). When present and
   * still in the future, the `queued` caption shows a live countdown to it
   * instead of the bare animated dots.
   */
  queueReadyAt?: number | null;
  /** Epoch ms the displayed price was observed (null ⇒ use `fallbackDate`). */
  asOf: number | null;
  /**
   * Epoch ms the displayed price was actually *pulled* from the network (its
   * fetch / cache-store instant). The quiet "Updated <time>" stamp reflects this
   * pull moment — when the app last refreshed the holding — rather than `asOf`,
   * which is when the price itself was struck. Falls back to `asOf` when absent.
   */
  pulledAt?: number | null;
  /** Value-date the price applies to when `asOf` is null (a NAV's strike day). */
  fallbackDate: string;
  /** Epoch ms this holding last had a *fresh* price pulled, for the success flash. */
  updatedAt?: number | null;
  /** "Now" as epoch ms — compared against `updatedAt` for the flash window. */
  nowMs: number;
  /** "Now" as a Date, for locale-aware time formatting. */
  now?: Date;
}

/**
 * Resolve the holding's status caption for the current instant. A live phase
 * (the App is actively pulling, or the holding is queued behind the free-tier
 * budget) always wins; otherwise a holding pulled within the last
 * {@link HOLDING_UPDATED_FLASH_MS} shows its success flash; otherwise it rests on
 * the quiet "Updated <time>" stamp.
 */
export function resolveHoldingStatus(input: ResolveHoldingStatusInput): HoldingStatusView {
  const now = input.now ?? new Date(input.nowMs);

  if (input.livePhase === "updating" || input.livePhase === "queued") {
    const queued = input.livePhase === "queued";
    // A queued holding waiting behind the free-tier per-minute budget shows a
    // live seconds countdown to its expected turn (resolved from its queue
    // position) so the wait is legible — "Updating 120" — rather than a "…".
    let countdown: string | null = null;
    let title = queued ? "Queued for the next update…" : "Fetching the latest price…";
    if (queued && input.queueReadyAt !== null && input.queueReadyAt !== undefined) {
      const remaining = input.queueReadyAt - input.nowMs;
      if (remaining > 0) {
        countdown = formatQueueCountdown(remaining);
        title = `Queued behind the free-tier limit — about ${countdown}s until this price updates`;
      }
    }
    return {
      kind: input.livePhase,
      label: "Updating",
      stamp: null,
      // Show the dots only while no countdown is available; the timer replaces
      // them once a queue ETA is known so the caption reads as a real estimate.
      dots: countdown === null,
      check: false,
      countdown,
      title,
    };
  }

  // The quiet caption states *when this holding was last pulled*, not when its
  // price applies to — so it reflects the network fetch instant (`pulledAt`) and
  // falls back to the price's strike time only when no pull time is known.
  const stampInstant = input.pulledAt ?? input.asOf;
  const stamp = formatUpdatedAt(stampInstant, input.fallbackDate, now);
  const when = stampInstant ?? null;
  const fullWhen = when !== null ? formatLastPull(when, now) : stamp;

  if (
    input.updatedAt !== null &&
    input.updatedAt !== undefined &&
    input.nowMs - input.updatedAt >= 0 &&
    input.nowMs - input.updatedAt < HOLDING_UPDATED_FLASH_MS
  ) {
    return {
      kind: "updated",
      label: "Updated",
      stamp: null,
      dots: false,
      check: true,
      countdown: null,
      title: `Updated ${formatLastPull(input.updatedAt, now)}`,
    };
  }

  return {
    kind: "idle",
    label: "Updated",
    stamp,
    dots: false,
    check: false,
    countdown: null,
    title: `Last updated ${fullWhen}`,
  };
}

/**
 * Format a remaining-time span (ms) as a whole-seconds countdown — `"120"`,
 * `"119"`, … `"1"`. Deliberately seconds-only (never `m:ss`) so a queued wait
 * past a minute keeps ticking down a single number. Always at least `"0"`;
 * sub-second remainders round up so the timer shows `"1"` rather than `"0"` in
 * its final second.
 */
export function formatQueueCountdown(remainingMs: number): string {
  return String(Math.max(0, Math.ceil(remainingMs / 1000)));
}

/** The free-tier round cadence and capacity {@link computeQueueEtas} reasons over. */
export interface QueueEtaParams {
  /**
   * Symbols that were freshly pulled this round (they occupy the just-completed
   * round and are already done, so they do not shift the deferred ETAs). Retained
   * for context / telemetry.
   */
  fetched: readonly string[];
  /** Symbols deferred this round, in priority (pull) order — index 0 goes first. */
  deferred: readonly string[];
  /** How many symbols a single free-tier round can pull (credits per minute). */
  capacityPerRound: number;
  /** Epoch ms the round that produced this split completed (the countdown anchor). */
  anchorMs: number;
  /** Spacing between free-tier rounds in ms (≈ one minute on the free tier). */
  roundIntervalMs: number;
}

/**
 * Resolve, per deferred symbol, the epoch ms it is expected to update — its place
 * in the free-tier pull queue turned into a wall-clock ETA the caption can count
 * down to.
 *
 * The anchor is the instant the round that produced this split *completed*, so the
 * symbols pulled in it (`fetched`) are already done — they do **not** push the
 * deferred queue any further out. The remaining symbols are retried
 * `capacityPerRound` at a time in the *subsequent* rounds, so a deferred symbol's
 * round is decided purely by its index among the deferred: `floor(index /
 * capacity) + 1`, and its ETA is `anchor + round × interval`.
 *
 * Counting the already-fetched symbols into the position was what made every
 * deferred ETA overestimate by a whole round — the first deferred symbol rides the
 * very next round (~1 min), not the one after (~2 min). The smart fan-out still
 * holds for deep queues: the first `capacity` deferred share the next round, the
 * following `capacity` the round after, and so on.
 */
export function computeQueueEtas(params: QueueEtaParams): Map<string, number> {
  const etas = new Map<string, number>();
  const capacity = Math.max(1, Math.trunc(params.capacityPerRound));
  params.deferred.forEach((symbol, index) => {
    if (!symbol) return;
    const round = Math.floor(index / capacity) + 1; // 1-based round among the deferred
    etas.set(symbol, params.anchorMs + round * params.roundIntervalMs);
  });
  return etas;
}

/**
 * The App's per-round status signals, threaded into the render layer so every
 * holding card paints the right point in its update cycle:
 *   - `phases`: symbols currently `updating` or `queued` (live, this round);
 *   - `updatedAt`: epoch ms each symbol last had a fresh price land (success flash);
 *   - `queueReadyAt`: epoch ms each *queued* symbol is expected to update next
 *     (its free-tier queue ETA — drives the countdown caption).
 */
export interface HoldingStatusModel {
  phases: Map<string, HoldingLivePhase>;
  updatedAt: Map<string, number>;
  queueReadyAt: Map<string, number>;
}

/** An empty status model — the default when no refresh context is available. */
export function emptyHoldingStatusModel(): HoldingStatusModel {
  return { phases: new Map(), updatedAt: new Map(), queueReadyAt: new Map() };
}
