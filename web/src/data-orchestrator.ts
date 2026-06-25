/**
 * Pillar 1 — the single pull orchestrator: the **one readable brain** that owns
 * *what / when / which-leg* every network pull does.
 *
 * It is a **pure** decision function. The four mechanisms (`start`, `auto`,
 * `manual`, `reset`) each build a {@link PullContext} and call {@link planPull};
 * the returned {@link PullPlan} names exactly which legs will run and why. The
 * mechanisms then dispatch the `true` legs to the **existing** fetchers, every
 * one already routed through `reservation.ts` (the credit authority) and the
 * `provider-breaker.ts` 429 breaker. This module never re-implements a fetcher
 * and never bypasses the budget or the breaker.
 *
 * Readability acceptance (the Pillar-1 goal): a developer can read this file top
 * to bottom and state, for any `(kind, market, freshness)`, exactly what will be
 * fetched — without opening another file. {@link describePlan} renders that same
 * answer into the polling log so the decision is never "undiscoverable".
 *
 * See `docs/centralized_data_pull_plan.md` §"Pillar 1 — The single orchestrator".
 */

import {
  type FreshnessTier,
  type MarketPhase,
  type PullLegs,
  allLegs,
  barClockHourDue,
  gradedPull,
  hasAnyLeg,
  noLegs,
  quoteRefreshDue,
} from "./freshness";

/**
 * The complete set of pull mechanisms. Everything else (visibility, online,
 * pageshow, range toggle, graph click) is either one of these or is
 * regenerate-only (no network) — see Pillar 6.
 */
export type PullKind = "start" | "auto" | "manual" | "reset";

/** The freshness signals the orchestrator keys on (best-available, not on-device). */
export interface PullFreshness {
  /** Age of the freshest device price data (newest quote/bar), ms. */
  dataAgeMs: number;
  /** Whole market days of price data missing on the device. */
  deviceDaysMissing: number;
  /**
   * Whole market days the **best-available** blob trails by, from blob metadata
   * (timestamp + coverage) — not the on-device blob's age.
   */
  blobDaysOld: number;
  /** Age of the freshest live quote, ms (for the rolling quote-TTL overlay). */
  quoteAgeMs: number;
  /** Whether today's NAV prices are already held. */
  navHeldForToday: boolean;
}

/** Per-symbol-independent bar-gate state for the clock-hour overlay. */
export interface PullBarGate {
  /** When 1D bars were last pulled this session (epoch ms), or null if never. */
  lastBarPullMs: number | null;
  /** This session's 09:30 ET open, epoch ms. */
  sessionOpenMs: number;
}

/** Everything {@link planPull} needs to decide a pull. All clocks injected. */
export interface PullContext {
  kind: PullKind;
  nowMs: number;
  market: MarketPhase;
  /** Trading time elapsed since this session's open, ms (0 when closed). */
  minutesSinceOpenMs: number;
  /** Configured user-editable auto-update interval, ms. */
  autoIntervalMs: number;
  freshness: PullFreshness;
  barGate: PullBarGate;
}

/** The orchestrator's verdict: the legs to run, the tier, and a human reason. */
export interface PullPlan {
  kind: PullKind;
  tier: FreshnessTier;
  legs: PullLegs;
  /** One-line, log-ready explanation of the decision. */
  reason: string;
}

/**
 * Decide the pull for one mechanism invocation. Pure; the caller dispatches the
 * `true` legs to the existing fetchers.
 *
 * - **`reset`** — the heaviest escape hatch: a full re-pull of every leg. It
 *   clears soft freshness/backoff (downstream), but **never** the budget or the
 *   breaker — those still bind every leg it fires.
 * - **`start` / `manual`** — run the Pillar-4 truth-table, then layer the two
 *   market-hours overlays (clock-hour bar gate + rolling quote TTL). A manual tap
 *   forces a quote re-pull (the user is explicitly asking "is there anything
 *   new?"), so it skips the rolling-TTL suppression.
 * - **`auto`** — the steady cadence: identical table + overlays, fully gated, so
 *   a tick that finds everything fresh pulls nothing.
 */
export function planPull(ctx: PullContext): PullPlan {
  if (ctx.kind === "reset") {
    return {
      kind: ctx.kind,
      tier: "heavily-outdated",
      legs: allLegs(),
      reason: "reset: full re-pull of every leg (budget + breaker still bind)",
    };
  }

  const graded = gradedPull({
    dataAgeMs: ctx.freshness.dataAgeMs,
    deviceDaysMissing: ctx.freshness.deviceDaysMissing,
    blobDaysOld: ctx.freshness.blobDaysOld,
    market: ctx.market,
    minutesSinceOpenMs: ctx.minutesSinceOpenMs,
    autoIntervalMs: ctx.autoIntervalMs,
    navHeldForToday: ctx.freshness.navHeldForToday,
  });

  const legs: PullLegs = { ...graded.legs };
  const notes: string[] = [];

  // Overlay 1 — the clock-hour bar gate is the SOLE 1D-bar authority during
  // market hours, in **both** directions, so one plan per round decides bars and
  // legs together (no second bars-only plan that could disagree):
  //   - a new clock hour is **due** ⇒ turn the 1D bar leg *on*, even when the
  //     freshness tier alone wouldn't have asked for it (e.g. quotes are fresh but
  //     a `:00` has passed) — the gate, not the tier, owns the bar during hours;
  //   - **not** due ⇒ drop the bar legs; breadcrumbs carry the line to the next
  //     `:00`.
  // Outside market hours the table governs bar pulls directly (a missing settled
  // close still backfills, self-gated by the executor).
  if (ctx.market === "open") {
    const barsDue = barClockHourDue({
      nowMs: ctx.nowMs,
      lastBarPullMs: ctx.barGate.lastBarPullMs,
      sessionOpenMs: ctx.barGate.sessionOpenMs,
    });
    if (barsDue) {
      if (!legs.dayBars) {
        legs.dayBars = true;
        notes.push("1D bar due (clock-hour gate)");
      }
    } else if (legs.dayBars || legs.weekBars) {
      legs.dayBars = false;
      legs.weekBars = false;
      notes.push("bars held (clock-hour gate)");
    }
  }

  // Overlay 2 — rolling quote TTL. A manual tap always re-pulls quotes; auto /
  // start respect the rolling window so a within-TTL quote isn't re-bought.
  if (legs.quotes && ctx.kind !== "manual") {
    if (!quoteRefreshDue(ctx.nowMs - ctx.freshness.quoteAgeMs, ctx.nowMs)) {
      legs.quotes = false;
      notes.push("quotes held (within rolling TTL)");
    }
  }

  const reason = describeLegs(graded.tier, legs, notes);
  return { kind: ctx.kind, tier: graded.tier, legs, reason };
}

/** The leg names, in display order, that are switched on in `legs`. */
function activeLegNames(legs: PullLegs): string[] {
  const names: string[] = [];
  if (legs.weekBars) names.push("1W bars");
  if (legs.dayBars) names.push("1D bars");
  if (legs.quotes) names.push("quotes");
  if (legs.nav) names.push("NAV");
  if (legs.fx) names.push("FX");
  return names;
}

function describeLegs(tier: FreshnessTier, legs: PullLegs, notes: string[]): string {
  const active = activeLegNames(legs);
  const head = active.length > 0 ? `pull ${active.join(" + ")}` : "pull nothing";
  const tail = notes.length > 0 ? ` [${notes.join("; ")}]` : "";
  return `${tier}: ${head}${tail}`;
}

/**
 * A one-line, log-ready summary of a plan, e.g.
 * `start → relatively-fresh: pull quotes + FX`. Surfacing every decision in the
 * polling log is what stops the pull policy being "undiscoverable" — an original
 * observability win for the Pillar-1 readability goal.
 */
export function describePlan(plan: PullPlan): string {
  return `${plan.kind} → ${plan.reason}`;
}

/** Whether a plan will touch the network at all (false ⇒ a pure no-op tick). */
export function planPullsAnything(plan: PullPlan): boolean {
  return hasAnyLeg(plan.legs);
}

/** Re-exported so a caller can build an empty plan without importing freshness. */
export { noLegs };
