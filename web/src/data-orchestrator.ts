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
  ONE_HOUR_MS,
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
  /**
   * Age of the cached live EUR/USD spot, ms (for the FX-freshness overlay).
   * Omitting this (or `undefined`) is treated as `Infinity` — FX is considered
   * stale and the orchestrator will turn the FX leg on when the tier calls for it.
   */
  fxAgeMs?: number;
  /** Whether today's NAV prices are already held. */
  navHeldForToday: boolean;
}

/**
 * The shared **device-days-missing** gate, keyed on the same evidence both passes
 * see, so the pre-decrypt warm-up and the post-decrypt kickoff grade a market gap
 * identically (Pillar 1 — one brain). The caller decides `anyMarketMissing` with
 * the C1 currency-known gate already applied: a market quote that is simply absent
 * counts as a missing day **only** when that symbol's native currency is known, so
 * a genuine first-ever login (currency unknown, empty cache) is the unknown-start
 * state — not a faked 10-day "heavily-outdated" gap that triggers a full re-pull.
 *
 *  - `anyMarketMissing` (a known-currency market symbol with no cached quote) ⇒ 10
 *    (the heaviest market gap — restore today's full pass);
 *  - else `marketStale` (a held close trails the latest settled session) ⇒ 1, or 2
 *    once the freshest mark is itself more than a day (26h) old;
 *  - else 0 (the book holds every settled close).
 */
export function deviceDaysMissing(args: {
  anyMarketMissing: boolean;
  marketStale: boolean;
  dataAgeMs: number;
}): number {
  if (args.anyMarketMissing) return 10;
  if (args.marketStale) return args.dataAgeMs > 26 * ONE_HOUR_MS ? 2 : 1;
  return 0;
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
  /**
   * C1 — which pass of the single planner this is. `"pre-decrypt"` is the login
   * warm-up (the encrypted model is not yet available); `"post-decrypt"` is the
   * kickoff/auto round. Defaults to `"post-decrypt"`. Decision-neutral today (the
   * gradedPull math is unchanged); carried so the decision is self-describing and
   * a pre-decrypt pass can be reasoned about as a first-class state.
   */
  phase?: "pre-decrypt" | "post-decrypt";
  /**
   * C1 — whether each holding's native currency is known this pass. `false` only
   * on a genuine first-ever login with no saved plan (C2). When the currency is
   * unknown an empty quote cache is **not** evidence of missing market days, so
   * the caller must not inflate {@link PullFreshness.deviceDaysMissing} from it —
   * that empty-cache inflation is the very bug that faked "heavily-outdated" and
   * triggered a full re-pull. Defaults to `true` (currency known).
   */
  currencyKnown?: boolean;
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
  //   - **not** due ⇒ drop the 1D bar leg; breadcrumbs carry the line to the next
  //     `:00`.
  // The gate is the 1D authority *only*: it never touches `weekBars` (history
  // backfill stays owned by the table). It also never strips when the tier is
  // `heavily-outdated`, so a stale manual/auto round in a non-`:00` window still
  // backfills missing history. Outside market hours the table governs bar pulls
  // directly (a missing settled close still backfills, self-gated by the executor).
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
    } else if (legs.dayBars && graded.tier !== "heavily-outdated") {
      legs.dayBars = false;
      notes.push("1D bar held (clock-hour gate)");
    }
  }

  // Overlay 2 — rolling quote TTL, keyed on the **user-set auto-refresh interval**.
  // A manual tap always re-pulls quotes (the user is asking "is there anything
  // new?"); auto / start respect the window so a within-interval quote isn't
  // re-bought. Removing the old hardcoded 15-min default: the window is now
  // whatever the user configured, so lowering the refresh rate visibly speeds up
  // quotes.
  if (legs.quotes && ctx.kind !== "manual") {
    if (!quoteRefreshDue(ctx.nowMs - ctx.freshness.quoteAgeMs, ctx.nowMs, ctx.autoIntervalMs)) {
      legs.quotes = false;
      notes.push("quotes held (within rolling TTL)");
    }
  }

  // Overlay 3 — FX freshness gate, keyed on the same user-set interval.
  // A manual tap always re-pulls FX; auto / start suppress it when the live spot
  // was pulled within the interval, so the login warm-up pull isn't wasted by the
  // immediately-following kickoff round (the 45-second reuse window this replaces).
  if (legs.fx && ctx.kind !== "manual") {
    const fxAge = ctx.freshness.fxAgeMs ?? Number.POSITIVE_INFINITY;
    if (fxAge < ctx.autoIntervalMs) {
      legs.fx = false;
      notes.push("FX held (within interval)");
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
