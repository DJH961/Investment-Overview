/**
 * Pure decision core for the **web** Tiingo fallback — no I/O, no network.
 *
 * This is the browser mirror of the desktop `services/tiingo_fallback.py`: the
 * exact same smart-gate and NAV peer-confirmation + canary logic from
 * `docs/tiingo_fallback_plan.md`, ported to TypeScript. It answers the one hard
 * question — *when is it smart to spend a Tiingo call?* — as side-effect-free
 * functions over explicit inputs (persisted stamps/counters + the resolved
 * market calendar), so every gate and scenario is unit-testable in isolation.
 *
 * Web differs from desktop only in the numbers: the shared Tiingo account is
 * split 20 % desktop / 80 % web, so the web side self-caps at **40/hr · 800/day**
 * (desktop is 10/200). All timing is evaluated as *elapsed since a stored stamp*,
 * never a live countdown, so a due probe fires the instant the app is reopened.
 */

import { onProviderLimitsChange } from "./provider-limits";

const MINUTE_MS = 60 * 1000;

// --- Web budget (80 % of the shared Tiingo account) --------------------------
/**
 * Default web-side Tiingo caps (40/hr · 800/day). The live exports below mirror
 * the configurable {@link providerLimits} store, so lowering them in Settings
 * (e.g. to share the account across more devices) flows through every budget
 * check. They default to these documented ceilings.
 */
export const DEFAULT_WEB_HOURLY_CAP = 40;
export const DEFAULT_WEB_DAILY_CAP = 800;
export let WEB_HOURLY_CAP = DEFAULT_WEB_HOURLY_CAP;
export let WEB_DAILY_CAP = DEFAULT_WEB_DAILY_CAP;
onProviderLimitsChange((limits) => {
  WEB_HOURLY_CAP = limits.tiingoPerHour;
  WEB_DAILY_CAP = limits.tiingoPerDay;
});

// --- NAV-late: peer-confirmation + canary (Eastern minutes-since-midnight) ----
/** No NAV realistically strikes before 17:30 ET, so a canary before it is waste. */
export const NAV_FIRST_PROBE_FLOOR_MIN = 17 * 60 + 30; // 17:30 ET
/** Added past the (floor or learned-earliest) publish time before the first probe. */
export const NAV_PROBE_GRACE_MS = 15 * MINUTE_MS;
/** After the first peer NAV is seen, wait this long for the trickle to finish. */
export const NAV_PEER_GRACE_MS = 30 * MINUTE_MS;
/**
 * @deprecated The NAV-posting "active window" is deprecated. NAV publish times
 * drift and the first-probe floor (~17:45 ET) already gates the evening, so a
 * separate 17:30–19:00 window no longer changes any decision. Retained only so
 * existing imports keep resolving; {@link navCooldownFor} ignores it.
 */
export const NAV_WINDOW_START_MIN = 17 * 60 + 30; // 17:30 ET
/** @deprecated See {@link NAV_WINDOW_START_MIN}. No longer consulted. */
export const NAV_WINDOW_END_MIN = 19 * 60; // 19:00 ET
/**
 * The single canary-probe cooldown. With the posting window deprecated there is
 * no longer an in-/off-window split: every evening probe waits this long.
 */
export const NAV_PROBE_COOLDOWN_MS = 15 * MINUTE_MS;
/** @deprecated Use {@link NAV_PROBE_COOLDOWN_MS}; the window split is gone. */
export const NAV_COOLDOWN_IN_WINDOW_MS = NAV_PROBE_COOLDOWN_MS;
/** @deprecated Use {@link NAV_PROBE_COOLDOWN_MS}; the window split is gone. */
export const NAV_COOLDOWN_OFF_WINDOW_MS = NAV_PROBE_COOLDOWN_MS;
/** Hard backstop on canary probes per ET day (an all-evening outage costs ≤ this). */
export const NAV_MAX_PROBES_PER_DAY = 8;

/**
 * Minutes since the most recent ET (America/New_York) midnight for an epoch — the
 * Eastern wall-clock time-of-day the NAV gates reason about. DST-correct: it
 * reads the actual ET clock parts rather than applying a fixed offset.
 */
export function etMinutesOfDay(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(now));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") % 24; // `hour12:false` can render midnight as "24".
  return hour * 60 + get("minute");
}

/** A side's remaining Tiingo allowance across the hour and day windows. */
export class Budget {
  constructor(
    readonly hourUsed: number,
    readonly dayUsed: number,
    readonly hourlyCap: number = WEB_HOURLY_CAP,
    readonly dailyCap: number = WEB_DAILY_CAP,
  ) {}

  remaining(): number {
    // Clamp the used counts at 0 so an over-refund (a negative net spend, e.g. a
    // refund booked in a fresh clock hour for a charge taken in the previous one)
    // can never make `cap - used` exceed the cap and hand out phantom headroom.
    const hourUsed = Math.max(0, this.hourUsed);
    const dayUsed = Math.max(0, this.dayUsed);
    return Math.max(0, Math.min(this.hourlyCap - hourUsed, this.dailyCap - dayUsed));
  }

  hasRoom(): boolean {
    return this.remaining() > 0;
  }
}

/** Trim an eligible-symbol list to what the budget can actually pay for. */
export function selectWithinBudget(symbols: readonly string[], budget: Budget): string[] {
  const room = budget.remaining();
  return room > 0 ? symbols.slice(0, room) : [];
}

/**
 * Whether a **market** (non-NAV) symbol is worth a Tiingo call (budget applied
 * separately by the caller):
 *
 *  - **Trigger:** the primary fell short (failed / over-quota), or we hold
 *    nothing, or what we hold is older than the latest settled session.
 *  - **Worth it:** newer data actually exists — we hold nothing, or are behind
 *    the settled session. A transient primary error while we already hold the
 *    expected session is therefore *not* worth a call.
 */
export function marketSymbolEligible(args: {
  heldDate: string | null;
  expectedDate: string;
  primaryFailed: boolean;
}): boolean {
  const behind = args.heldDate === null || args.heldDate < args.expectedDate;
  const triggered = args.primaryFailed || behind;
  if (!triggered) return false;
  return behind; // nothing newer to get ⇒ skip
}

export type NavAction = "wait" | "fetch_laggards" | "canary";

export interface NavDecision {
  action: NavAction;
  symbols: string[];
  reason: string;
}

/**
 * The probe cooldown (ms). The NAV-posting window is deprecated, so this is now a
 * single flat cooldown ({@link NAV_PROBE_COOLDOWN_MS}) regardless of the time of
 * day. The `etMin` parameter is retained for signature compatibility but ignored.
 */
export function navCooldownFor(_etMin: number): number {
  return NAV_PROBE_COOLDOWN_MS;
}

/**
 * The earliest Eastern minutes-of-day a canary may fire:
 * `max(17:30 floor, earliest learned habit) + 15 min`. With no learned habit the
 * floor governs, so a cold-start first probe lands ~17:45 ET.
 */
export function firstProbeMinutes(earliestHabitMin: number | null): number {
  const base = earliestHabitMin !== null ? Math.max(NAV_FIRST_PROBE_FLOOR_MIN, earliestHabitMin) : NAV_FIRST_PROBE_FLOOR_MIN;
  return base + NAV_PROBE_GRACE_MS / MINUTE_MS;
}

function decideNavPeer(
  missingFunds: readonly string[],
  peerPublishedAt: number | null,
  now: number,
  budget: Budget,
): NavDecision {
  if (peerPublishedAt !== null && now - peerPublishedAt < NAV_PEER_GRACE_MS) {
    return { action: "wait", symbols: [], reason: "within peer-trickle grace" };
  }
  const laggards = selectWithinBudget(missingFunds, budget);
  if (laggards.length === 0) {
    return { action: "wait", symbols: [], reason: "budget exhausted" };
  }
  return { action: "fetch_laggards", symbols: laggards, reason: "peer-confirmed laggards" };
}

function decideNavCanary(
  canaryPick: string | null,
  earliestHabitMin: number | null,
  lastCanaryAt: number | null,
  canaryCountToday: number,
  now: number,
): NavDecision {
  const etMin = etMinutesOfDay(now);
  if (etMin < firstProbeMinutes(earliestHabitMin)) {
    return { action: "wait", symbols: [], reason: "before first-probe time" };
  }
  if (canaryCountToday >= NAV_MAX_PROBES_PER_DAY) {
    return { action: "wait", symbols: [], reason: "daily canary cap reached" };
  }
  const cooldown = navCooldownFor(etMin);
  if (lastCanaryAt !== null && now - lastCanaryAt < cooldown) {
    return { action: "wait", symbols: [], reason: "within canary cooldown" };
  }
  if (canaryPick === null) {
    return { action: "wait", symbols: [], reason: "no canary candidate" };
  }
  return { action: "canary", symbols: [canaryPick], reason: "canary probe" };
}

/**
 * Decide the NAV path for one refresh cycle (the plan's two tiers). Inputs are
 * all caller-resolved facts:
 *
 *  - `missingFunds` — held NAV funds still missing the target session's NAV.
 *  - `peerPublished` / `peerPublishedAt` — did the *primary* (Twelve Data) return
 *    a fresh target-date NAV for some other fund, and when was it first seen?
 *  - `canaryPick` — the single fund to probe when there is no peer evidence
 *    (earliest/most-reliable publisher; `null` if none qualifies).
 *  - `earliestHabitMin` — earliest learned ET publish minute-of-day, or null.
 *  - `lastCanaryAt` / `canaryCountToday` — persisted probe stamps (ET day).
 *
 * The caller executes the decision and, on a *fresh* canary result, promotes
 * every still-missing fund to a laggard fetch.
 */
export function decideNav(args: {
  missingFunds: readonly string[];
  peerPublished: boolean;
  peerPublishedAt: number | null;
  canaryPick: string | null;
  earliestHabitMin: number | null;
  lastCanaryAt: number | null;
  canaryCountToday: number;
  now: number;
  budget: Budget;
}): NavDecision {
  if (args.missingFunds.length === 0) {
    return { action: "wait", symbols: [], reason: "no missing NAV funds" };
  }
  if (!args.budget.hasRoom()) {
    return { action: "wait", symbols: [], reason: "budget exhausted" };
  }
  if (args.peerPublished) {
    return decideNavPeer(args.missingFunds, args.peerPublishedAt, args.now, args.budget);
  }
  return decideNavCanary(
    args.canaryPick,
    args.earliestHabitMin,
    args.lastCanaryAt,
    args.canaryCountToday,
    args.now,
  );
}
