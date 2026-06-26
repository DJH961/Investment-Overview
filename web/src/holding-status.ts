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
  /** Full tooltip naming the exact moment / what's happening. */
  title: string;
}

export interface ResolveHoldingStatusInput {
  /** A live phase asserted by the App for this round, if any. */
  livePhase?: HoldingLivePhase | null;
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
    return {
      kind: input.livePhase,
      label: "Updating",
      stamp: null,
      dots: true,
      check: false,
      title: queued ? "Queued for the next update…" : "Fetching the latest price…",
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
      title: `Updated ${formatLastPull(input.updatedAt, now)}`,
    };
  }

  return {
    kind: "idle",
    label: "Updated",
    stamp,
    dots: false,
    check: false,
    title: `Last updated ${fullWhen}`,
  };
}

/**
 * The App's per-round status signals, threaded into the render layer so every
 * holding card paints the right point in its update cycle:
 *   - `phases`: symbols currently `updating` or `queued` (live, this round);
 *   - `updatedAt`: epoch ms each symbol last had a fresh price land (success flash).
 */
export interface HoldingStatusModel {
  phases: Map<string, HoldingLivePhase>;
  updatedAt: Map<string, number>;
}

/** An empty status model — the default when no refresh context is available. */
export function emptyHoldingStatusModel(): HoldingStatusModel {
  return { phases: new Map(), updatedAt: new Map() };
}
