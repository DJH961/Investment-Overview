/**
 * The **single reservation authority** for every metered provider request —
 * `docs/provider_rate_limit_audit.md` Recommendation 4.
 *
 * Before this module each call site re-implemented its own budget check (and
 * several graph legs omitted it entirely — audit Flags 1–3, 5), and even the
 * gated paths read the live budget and *then* debited it in two separate steps,
 * so two concurrent legs/builds could each see the full budget and collectively
 * overshoot (audit Flag 6). This module makes "respect the limit" **structural**
 * rather than per-call-site: every provider request passes through one
 * {@link Reservation.reserve}, which **atomically** (in a single synchronous
 * turn — JS never interleaves before the first `await`) reads the live shared
 * ledger *and* debits the grant, returning how many credits were actually
 * granted. Callers fetch only the granted count; an unbilled result is handed
 * back with {@link Reservation.release}.
 *
 * The grant already folds in:
 *  - **Twelve Data** — the live 8/min · 800/day headroom from the shared credit
 *    ledger, **zeroed for the minute while the 429 circuit breaker is frozen**
 *    (`provider-breaker.ts`).
 *  - **Tiingo** — the scarce 40/hr · 800/day web budget (`tiingo-gate.ts`),
 *    **zeroed entirely while Tiingo is frozen** until the next clock `:00`.
 *
 * So a single `reserve(provider, n)` is the one place that knows both budgets and
 * both freezes; no graph/FX/NAV path can fire over the cap, and no future call
 * site silently starts ungated. Pure over an injected clock + storage, so every
 * grant/release transition is unit-testable with no network.
 */

import {
  readCreditLog,
  recordCredits,
  releaseCredits,
  creditsSpentWithin,
  creditsSpentToday,
  creditsSpentThisHour,
  readTiingoCreditLog,
  recordTiingoCredits,
  releaseTiingoCredits,
  tiingoCreditsSpentToday,
  type StorageLike,
} from "./cache";
import { twelveDataFrozen, tiingoFrozen } from "./provider-breaker";
import { Budget, WEB_HOURLY_CAP, WEB_DAILY_CAP } from "./tiingo-gate";
import { FREE_TIER } from "./quotes";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The two metered providers the authority arbitrates. */
export type Provider = "twelvedata" | "tiingo";

/**
 * Live remaining Twelve Data credits at `now` — the lesser of the per-minute and
 * per-day headroom on the shared ledger, **0 for the minute while the 429
 * breaker is frozen** (a 429 reconciles the optimistic local count down to "no
 * room" regardless of what our ledger thinks).
 */
export function twelveDataAvailable(
  now: number,
  storage: StorageLike | null = null,
): number {
  const s = storage ?? undefined;
  if (twelveDataFrozen(now, s)) return 0;
  const log = readCreditLog(now, DAY_MS, s);
  const minute = Math.max(0, FREE_TIER.creditsPerMinute - Math.max(0, creditsSpentWithin(log, now, MINUTE_MS)));
  const day = Math.max(0, FREE_TIER.creditsPerDay - Math.max(0, creditsSpentToday(log, now)));
  return Math.min(minute, day);
}

/**
 * Live remaining Tiingo credits at `now` — the scarce 40/hr · 800/day web budget,
 * **0 while Tiingo is frozen** to the next `:00`. The hourly window resets on the
 * clock hour (matching `tiingo-fallback.ts` and the 429 breaker freeze) rather
 * than a trailing 60-min window, so a burst at :55 doesn't suppress the fresh
 * allowance the user expects at the top of the next hour. The used counts are
 * clamped at 0 so an over-refund can't inflate the budget past the cap. This is
 * the gate the graph overflow/spill and FX legs never had before (audit Flags 1,
 * 2, 5).
 */
export function tiingoAvailable(
  now: number,
  storage: StorageLike | null = null,
): number {
  const s = storage ?? undefined;
  if (tiingoFrozen(now, s)) return 0;
  const log = readTiingoCreditLog(now, DAY_MS, s);
  const budget = new Budget(
    Math.max(0, creditsSpentThisHour(log, now)),
    Math.max(0, tiingoCreditsSpentToday(log, now)),
    WEB_HOURLY_CAP,
    WEB_DAILY_CAP,
  );
  return budget.remaining();
}

/**
 * Live Twelve Data headroom split into its two windows at `now`: the per-minute
 * pool (the plentiful 8/min that replenishes on a rolling 60s window) and the
 * per-day pool (the scarce 800/day). Both are floored at 0 and **0 for the
 * minute while the 429 breaker is frozen**, mirroring {@link twelveDataAvailable}
 * (whose grant is the lesser of the two). Used to print an honest
 * `N/min · M/day` budget read-out outside a refresh round (e.g. the Settings
 * regenerate summary), where there is no {@link QuoteLoadReport} to read.
 */
export function twelveDataBudgetView(
  now: number,
  storage: StorageLike | null = null,
): { minuteRemaining: number; dayRemaining: number } {
  const s = storage ?? undefined;
  const log = readCreditLog(now, DAY_MS, s);
  const day = Math.max(0, FREE_TIER.creditsPerDay - Math.max(0, creditsSpentToday(log, now)));
  if (twelveDataFrozen(now, s)) return { minuteRemaining: 0, dayRemaining: day };
  const minute = Math.max(0, FREE_TIER.creditsPerMinute - Math.max(0, creditsSpentWithin(log, now, MINUTE_MS)));
  return { minuteRemaining: minute, dayRemaining: day };
}

/**
 * Milliseconds until the Twelve Data **per-minute** pool is fully replenished —
 * i.e. the next instant at which the whole 8/min cap is spendable again because
 * every spend has aged out of the rolling 60s window. Returns `0` when the
 * minute is already clear (or the day pool is the only thing capping us). Capped
 * at {@link MINUTE_MS} since a rolling-minute window can never need longer.
 *
 * This is what lets a Settings-triggered refresh **wait for the next fully
 * available Twelve Data window** rather than spilling onto the scarce Tiingo
 * budget when an auto-refresh has just drained the minute pool. The 429 freeze is
 * deliberately *not* folded in here: a freeze runs to the next clock `:00`, far
 * longer than the ≤60s minute wait this models, so a frozen provider simply
 * starts now and lets the normal deferral handle the overflow.
 */
export function twelveDataMinuteReadyDelayMs(
  now: number,
  storage: StorageLike | null = null,
): number {
  const s = storage ?? undefined;
  const log = readCreditLog(now, MINUTE_MS, s);
  if (creditsSpentWithin(log, now, MINUTE_MS) <= 0) return 0;
  // Each spend leaves the rolling window at `at + MINUTE_MS`; the window is clear
  // at the first such boundary where the net spend within it drops to ≤ 0.
  const boundaries = log
    .map((e) => e.at + MINUTE_MS)
    .filter((t) => t > now)
    .sort((a, b) => a - b);
  for (const t of boundaries) {
    if (creditsSpentWithin(log, t, MINUTE_MS) <= 0) return Math.min(MINUTE_MS, Math.max(0, t - now));
  }
  return 0;
}

/** Live remaining credits for either provider at `now`. */
export function available(
  provider: Provider,
  now: number,
  storage: StorageLike | null = null,
): number {
  return provider === "twelvedata" ? twelveDataAvailable(now, storage) : tiingoAvailable(now, storage);
}

/**
 * The single reservation authority. Both methods are synchronous so a
 * read-and-debit cannot be interleaved by another async leg.
 */
export interface Reservation {
  /**
   * Atomically grant up to `requested` credits for `provider` at `now`, debiting
   * the grant against the shared ledger **before** returning so concurrent
   * dispatches pace themselves. Returns how many credits were granted (`0` when
   * the budget is spent or the provider is frozen) — fetch only that many.
   */
  reserve(provider: Provider, requested: number, now: number): number;
  /**
   * Hand back `n` credits previously {@link reserve reserved} but not billed by
   * the provider (a 429 / transport throw / Worker reject), netting them out of
   * the running budget so a later request can use them again.
   */
  release(provider: Provider, n: number, now: number): void;
}

/**
 * The real reservation authority over the persisted shared credit ledgers (plus
 * the 429 breaker freezes). This is the production wiring; tests inject a fake
 * {@link Reservation} to assert grants without touching storage.
 */
export function ledgerReservation(storage: StorageLike | null = null): Reservation {
  return {
    reserve(provider, requested, now) {
      if (requested <= 0) return 0;
      const granted = Math.min(requested, available(provider, now, storage));
      if (granted <= 0) return 0;
      if (provider === "twelvedata") recordCredits(granted, now, storage ?? undefined);
      else recordTiingoCredits(granted, now, storage ?? undefined);
      return granted;
    },
    release(provider, n, now) {
      if (n <= 0) return;
      if (provider === "twelvedata") releaseCredits(n, now, storage ?? undefined);
      else releaseTiingoCredits(n, now, storage ?? undefined);
    },
  };
}
