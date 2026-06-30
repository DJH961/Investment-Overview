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
  /**
   * Whether the session EUR→USD **open/close bar anchor** the hero currency KPI
   * needs for the current market phase is absent on the device (see
   * {@link ../session-fx.sessionFxAnchorMissing}). Drives the `fxBars` leg so the
   * KPI's market-hours/overnight split is fed in every phase. Omitting it (or
   * `undefined`) is treated as `false` — no anchor pull is forced.
   */
  fxBarsAnchorMissing?: boolean;
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
 * - **`start` / `manual`** — run the Pillar-4 truth-table, then layer the
 *   market-hours overlays (clock-hour bar gate + rolling quote TTL). A **manual**
 *   tap is driven purely by RELEVANCE, never freshness: a fresh symbol can never
 *   swallow it (only the upstream double-click cooldown can — see
 *   `manualRefreshDecision`). It forces the legs that can actually have moved on —
 *   market symbols while open, NAVs-only post-close until the NAV arrives, every
 *   symbol once the close is in hand — so the executor's per-symbol skip, not the
 *   freshness tier, has the final say.
 * - **`auto`** — the steady cadence: identical table + overlays, fully gated, so
 *   a tick that finds everything fresh pulls nothing — except the moment the
 *   market closes with the day's NAV still awaited, when the `nav` leg is due at
 *   once (Overlay 0a) rather than after a further interval.
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

  // Overlay 0a — NAV-as-soon-as-closed (every cadence, auto included). The instant
  // the regular session closes the day's NAV funds begin publishing and are the
  // ONLY price that can still change, so whenever the market is shut and today's
  // NAV is not yet in hand the `nav` leg is due — a fresh quote book must NOT keep
  // the tier at `fresh` and starve the NAV pull until the next interval has
  // elapsed. The leg self-clears the moment the NAV lands (`navHeldForToday`), and
  // the executor re-clamps each symbol against the NAV cache TTL + per-series
  // backoff, so turning it on the moment it is awaited is safe and bounded.
  if (ctx.market === "closed" && !ctx.freshness.navHeldForToday && !legs.nav) {
    legs.nav = true;
    notes.push("NAV due (market closed, awaiting today's NAV)");
  }

  // Overlay 0b — manual relevance. A manual tap is driven by RELEVANCE, never
  // freshness: a fresh symbol must NEVER swallow a tap (only the upstream
  // double-click cooldown can — see `manualRefreshDecision`). There is a reason
  // the user asked, so the relevant price legs are forced on regardless of the
  // graded tier; the executor's per-symbol skip then decides the genuine work, so
  // a tap with everything already settled still spends nothing. Relevance by
  // market phase mirrors what can actually have moved:
  //   - market OPEN          → market symbols move ⇒ force quotes (NAV can't strike);
  //   - CLOSED, NAV awaited   → only NAVs can still change ⇒ NAV only (Overlay 0a);
  //   - CLOSED, NAV in hand    → nothing is mid-move ⇒ re-verify ALL symbols (quotes + NAV).
  if (ctx.kind === "manual") {
    if (ctx.market === "open") {
      if (!legs.quotes) {
        legs.quotes = true;
        notes.push("quotes forced (manual: market open)");
      }
    } else if (ctx.freshness.navHeldForToday) {
      // Outside both relevance windows (closed and today's NAV already in hand):
      // re-verify every symbol; the executor's per-symbol skip drops any that
      // already hold the latest settled mark, so this is bounded, not a blind pull.
      if (!legs.quotes) {
        legs.quotes = true;
        notes.push("quotes forced (manual: all symbols)");
      }
      if (!legs.nav) {
        legs.nav = true;
        notes.push("NAV forced (manual: all symbols)");
      }
    }
    // CLOSED with NAV still awaited needs no quotes leg here: Overlay 0a already lit
    // the NAV leg, and market symbols hold the settled close, so the tap is NAV-only.
  }

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
  // A manual tap always re-pulls FX — the exact "distrust the cache, re-pull even
  // though it is in hand" rule the holdings' quote leg follows above — so the live
  // EUR→USD spot that values the whole book is verified from scratch on every tap,
  // never served from a within-interval cache. This *forces* the leg on, not merely
  // skips the suppression: when the graded tier alone left FX off (a within-interval
  // "fresh" book), a tap still re-pulls it, so the currency view is supplied its
  // spot exactly as the holdings are supplied theirs. Auto / start instead suppress
  // the leg when the spot was pulled within the interval, so the login warm-up pull
  // isn't wasted by the immediately-following kickoff round (the 45-second reuse
  // window this replaces).
  if (ctx.kind === "manual") {
    if (!legs.fx) {
      legs.fx = true;
      notes.push("FX re-pulled (manual: distrust cache)");
    }
  } else if (legs.fx) {
    const fxAge = ctx.freshness.fxAgeMs ?? Number.POSITIVE_INFINITY;
    if (fxAge < ctx.autoIntervalMs) {
      legs.fx = false;
      notes.push("FX held (within interval)");
    }
  }

  // Overlay 4 — currency-KPI FX-bar anchor. The hero currency effect's
  // market-hours/overnight split is anchored to the session's EUR→USD open/close,
  // read from the stored 1D FX bar track. That track is a cheap one-shot pull the
  // orchestrator now owns as a first-class leg rather than an ad-hoc after-hours
  // side pipeline: whenever the anchor THIS market phase needs is absent
  // (`fxBarsAnchorMissing`) the leg is due on EVERY mechanism (start / auto /
  // manual / reset), so the KPI never has to fight a suppressed FX-spot leg for the
  // data its different phases need. It self-clears once the bar lands and the
  // fetcher is per-series backoff-bounded, so turning it on whenever missing is safe
  // and bounded. The mechanical de-dup against a session bar pull that already grabs
  // the FX track alongside the price bars lives at the dispatch site (it alone knows
  // whether session symbols are actually pulled this round).
  if (ctx.freshness.fxBarsAnchorMissing && !legs.fxBars) {
    legs.fxBars = true;
    notes.push("FX-bar anchor due (currency KPI)");
  }
  // A manual tap distrusts the cached FX **bars** too, the bar sibling of the spot
  // re-pull above and the holdings' quote re-pull: re-request the session EUR→USD
  // bar track the currency KPI / FX view draws on even when the anchor is already
  // in hand, so a tap supplies the FX view ALL the data its 1D/1W slices need
  // rather than trusting a possibly-stale cached track. The dispatch site de-dups
  // this against a session-bar prime that already grabs the FX track alongside the
  // price bars (it alone knows whether session symbols are pulled this round), and
  // the fetcher is per-series backoff-bounded, so a tap never double-buys the FX
  // bar within a round ("don't duplicate FX quotes and bars unless necessary").
  if (ctx.kind === "manual" && !legs.fxBars) {
    legs.fxBars = true;
    notes.push("FX bars re-pulled (manual: distrust cache)");
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
  if (legs.fxBars) names.push("FX bars");
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
