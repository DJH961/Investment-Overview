/**
 * Per-provider **429 circuit breaker** — the second tier of the two-tier brake
 * from `market_open_token_burn_fix_plan.md` (WS4) and the cross-device budget
 * integrity it enforces (WS5).
 *
 * Our internal credit ledger ({@link ../cache.readCreditLog}) is an *optimistic
 * local estimate*: on a **shared** API key, a second device's spend is invisible
 * to it, so the only authoritative, cross-device "you are out" signal is the
 * provider's own `429`. This module turns that hard "no" into a short, persisted
 * freeze so we stop hammering a provider that has already said no — the residual
 * backstop once demand-minimisation (WS1) and per-minute slicing (WS2) have
 * removed the bulk of the load.
 *
 *  - **Twelve Data 429 → freeze all Twelve Data for ~60s.** A *second consecutive*
 *    TD 429 (no successful TD call between) escalates to a **2-minute** freeze to
 *    absorb cross-device clock-skew, then the cycle resets (the next 429 starts
 *    fresh at 60s). A successful TD call clears the streak.
 *  - **Tiingo 429 → freeze Tiingo until the next clock hour (`:00`).** Tiingo is
 *    the scarce last line; once it says no, every further attempt is pure waste
 *    until its hourly bucket resets, so the freeze auto-clears at `:00` like the
 *    normal counter — no separate timer.
 *
 * **A 429 trips EVERYTHING.** Because the local credit ledger is only an
 * optimistic guess on a shared key, a single provider's `429` is the one hard,
 * authoritative "stop" we get — so it does not merely freeze the provider that
 * said no, it raises a **global freeze** ({@link BreakerState.global}) that holds
 * *every* metered provider until the longest freeze any 429 has armed lifts. One
 * provider's "out of credits" therefore stands the whole app down rather than
 * letting it keep hammering the other on a count that may already be stale.
 *
 * The freeze is consulted at the bar-fetch chokepoint: it zeroes Twelve Data's
 * live per-minute budget (so the capacity split routes nothing to it) and gates
 * the Tiingo overflow leg. State is persisted (survives reload) and pure over an
 * injected clock + storage, so every transition is unit-testable with no network.
 */

import { startOfHour, type StorageLike } from "./cache";

const BREAKER_KEY = "iv.web.provider_breaker";

/** First-strike Twelve Data freeze: one rolling minute. */
export const TD_FREEZE_MS = 60 * 1000;
/** Second consecutive Twelve Data 429: a two-minute cushion for clock-skew. */
export const TD_ESCALATED_FREEZE_MS = 2 * 60 * 1000;

interface TwelveDataBreaker {
  /** Epoch-ms the freeze lifts; ≤ now means not frozen. */
  frozenUntil: number;
  /** Consecutive-429 streak (reset by a success or after the 2-min escalation). */
  streak: number;
}

interface TiingoBreaker {
  /** Epoch-ms the freeze lifts (the next clock `:00`). */
  frozenUntil: number;
}

interface BreakerState {
  td?: TwelveDataBreaker;
  tiingo?: TiingoBreaker;
  /**
   * **The "trip EVERYTHING" freeze.** A `429` from *any* provider is the
   * authoritative, cross-device "you are out" signal — so it does not just freeze
   * the provider that returned it, it freezes *every* metered provider until this
   * timestamp. It is raised to the longest freeze any single 429 has armed (a TD
   * minute-freeze or a Tiingo hour-freeze), so one provider's "no" stops the whole
   * app from hammering the other on an optimistic local count that may already be
   * stale. Both {@link twelveDataFrozen} and {@link tiingoFrozen} consult it.
   */
  global?: number;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readState(storage: StorageLike | null): BreakerState {
  if (!storage) return {};
  try {
    const raw = storage.getItem(BREAKER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as BreakerState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(storage: StorageLike | null, state: BreakerState): void {
  if (!storage) return;
  try {
    storage.setItem(BREAKER_KEY, JSON.stringify(state));
  } catch {
    /* best-effort: a full/unavailable store just means no persisted breaker. */
  }
}

/**
 * The outcome of recording a provider `429`, returned so the caller can log a
 * precise, reconcilable line (the user must always be able to see in the log
 * *why* a provider's budget jumped to "full"):
 *  - `frozenUntil` — epoch-ms the freeze now lifts.
 *  - `alreadyFrozen` — whether a freeze was *already* armed before this 429 (so a
 *    caller can avoid logging the same freeze twice).
 *  - `escalated` — Twelve Data only: whether this was the second consecutive
 *    strike that escalated to the longer freeze.
 */
export interface Breaker429Result {
  frozenUntil: number;
  alreadyFrozen: boolean;
  escalated: boolean;
}

/**
 * Record a Twelve Data `429` (over-quota). Arms a 60s freeze on the first strike
 * and a 2-minute freeze on a second consecutive strike, then resets the cycle.
 * Returns the resulting freeze so the caller can log it (see
 * {@link Breaker429Result}).
 */
export function recordTwelveData429(
  now: number,
  storage: StorageLike | null = defaultStorage(),
): Breaker429Result {
  const state = readState(storage);
  const alreadyFrozen = (state.td?.frozenUntil ?? 0) > now;
  const prevStreak = state.td?.streak ?? 0;
  const newStreak = prevStreak + 1;
  let escalated = false;
  if (newStreak >= 2) {
    // Escalate, then reset the cycle: the *next* 429 starts fresh at 60s.
    state.td = { frozenUntil: now + TD_ESCALATED_FREEZE_MS, streak: 0 };
    escalated = true;
  } else {
    state.td = { frozenUntil: now + TD_FREEZE_MS, streak: newStreak };
  }
  // A 429 trips EVERYTHING: raise the global freeze so Tiingo is held too.
  state.global = Math.max(state.global ?? 0, state.td.frozenUntil);
  writeState(storage, state);
  return { frozenUntil: state.td.frozenUntil, alreadyFrozen, escalated };
}

/** A successful Twelve Data call clears the consecutive-429 streak. */
export function recordTwelveDataSuccess(
  storage: StorageLike | null = defaultStorage(),
): void {
  const state = readState(storage);
  if (!state.td || state.td.streak === 0) return;
  state.td = { ...state.td, streak: 0 };
  writeState(storage, state);
}

/** Whether Twelve Data is in an armed freeze at `now` (its own *or* the global
 * "a 429 trips everything" freeze). */
export function twelveDataFrozen(
  now: number,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  const state = readState(storage);
  return (state.td?.frozenUntil ?? 0) > now || (state.global ?? 0) > now;
}

/**
 * Epoch-ms a Twelve Data freeze lifts, or `null` when it is not frozen at `now`.
 * Lets a caller log *how long* the breaker will keep the provider at 0/min. The
 * effective lift is the later of Twelve Data's own freeze and the global
 * "a 429 trips everything" freeze (so a Tiingo 429 that froze the whole app is
 * reflected here too).
 */
export function twelveDataFreezeUntil(
  now: number,
  storage: StorageLike | null = defaultStorage(),
): number | null {
  const state = readState(storage);
  const until = Math.max(state.td?.frozenUntil ?? 0, state.global ?? 0);
  return until > now ? until : null;
}

/**
 * Record a Tiingo `429` (hourly reserve spent). Freezes Tiingo until the next
 * clock hour, mirroring Tiingo's own `:00` reset — no further attempt fires until
 * then because each one is pure waste. Returns the resulting freeze so the caller
 * can log *why* Tiingo's hourly budget jumped to full (see {@link Breaker429Result}).
 */
export function recordTiingo429(
  now: number,
  storage: StorageLike | null = defaultStorage(),
): Breaker429Result {
  const state = readState(storage);
  const alreadyFrozen = (state.tiingo?.frozenUntil ?? 0) > now;
  const HOUR_MS = 60 * 60 * 1000;
  state.tiingo = { frozenUntil: startOfHour(now) + HOUR_MS };
  // A 429 trips EVERYTHING: raise the global freeze so Twelve Data is held too.
  state.global = Math.max(state.global ?? 0, state.tiingo.frozenUntil);
  writeState(storage, state);
  return { frozenUntil: state.tiingo.frozenUntil, alreadyFrozen, escalated: false };
}

/** Whether Tiingo is frozen at `now` (its own freeze until the next clock `:00`,
 * *or* the global "a 429 trips everything" freeze armed by any provider). */
export function tiingoFrozen(
  now: number,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  const state = readState(storage);
  return (state.tiingo?.frozenUntil ?? 0) > now || (state.global ?? 0) > now;
}

/**
 * Epoch-ms a Tiingo freeze lifts (the later of its own `:00` reset and the global
 * "a 429 trips everything" freeze), or `null` when not frozen at `now`. Lets a
 * caller log the exact reset time alongside a "reads as full" line.
 */
export function tiingoFreezeUntil(
  now: number,
  storage: StorageLike | null = defaultStorage(),
): number | null {
  const state = readState(storage);
  const until = Math.max(state.tiingo?.frozenUntil ?? 0, state.global ?? 0);
  return until > now ? until : null;
}

/**
 * Apply the Twelve Data freeze to a live budget reading: while frozen, Twelve
 * Data's per-minute headroom reads **0**, so the capacity split (which slices to
 * `min(len, minute, day)`) routes nothing to it. This is the chokepoint that
 * makes the breaker authoritative — a 429 reconciles the optimistic local ledger
 * *down* to "no room" regardless of our internal count (WS5).
 */
export function applyTwelveDataFreeze(
  budget: { minute: number; day: number },
  now: number,
  storage: StorageLike | null = defaultStorage(),
): { minute: number; day: number } {
  return twelveDataFrozen(now, storage) ? { minute: 0, day: budget.day } : budget;
}

/** Forget all breaker state (test/reset helper). Not wired to hard-refresh. */
export function clearProviderBreaker(
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(BREAKER_KEY);
  } catch {
    /* best-effort */
  }
}
