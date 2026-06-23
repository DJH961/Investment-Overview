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

const MINUTE_MS = 60 * 1000;

// --- Web budget (80 % of the shared Tiingo account) --------------------------
export const WEB_HOURLY_CAP = 40;
export const WEB_DAILY_CAP = 800;

// --- NAV-late: peer-confirmation + canary (Eastern minutes-since-midnight) ----
/** No NAV realistically strikes before 17:30 ET, so a canary before it is waste. */
export const NAV_FIRST_PROBE_FLOOR_MIN = 17 * 60 + 30; // 17:30 ET
/** Added past the (floor or learned-earliest) publish time before the first probe. */
export const NAV_PROBE_GRACE_MS = 15 * MINUTE_MS;
/** After the first peer NAV is seen, wait this long for the trickle to finish. */
export const NAV_PEER_GRACE_MS = 30 * MINUTE_MS;
/** The active NAV-posting window (Eastern minutes); inside it we re-probe sooner. */
export const NAV_WINDOW_START_MIN = 17 * 60 + 30; // 17:30 ET
export const NAV_WINDOW_END_MIN = 19 * 60; // 19:00 ET
/** Probe cooldowns — tighter inside the active window, looser deep in the evening. */
export const NAV_COOLDOWN_IN_WINDOW_MS = 15 * MINUTE_MS;
export const NAV_COOLDOWN_OFF_WINDOW_MS = 30 * MINUTE_MS;
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
    return Math.max(0, Math.min(this.hourlyCap - this.hourUsed, this.dailyCap - this.dayUsed));
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

/** The probe cooldown (ms) that applies at an Eastern minutes-of-day time. */
export function navCooldownFor(etMin: number): number {
  const inWindow = etMin >= NAV_WINDOW_START_MIN && etMin <= NAV_WINDOW_END_MIN;
  return inWindow ? NAV_COOLDOWN_IN_WINDOW_MS : NAV_COOLDOWN_OFF_WINDOW_MS;
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
