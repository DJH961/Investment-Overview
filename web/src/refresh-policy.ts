/**
 * Auto-refresh cadence policy.
 *
 * The user's normal session is short: open the app for a minute or two, glance
 * at what's happening, and close it. So the *startup burst* matters most — every
 * holding should reach its latest live price as fast as the Twelve Data free
 * tier (8 credits/min, 1 per symbol) allows. A portfolio with more than eight
 * market symbols can't be priced in a single minute, so {@link loadQuotes}
 * defers the overflow; this policy then schedules the **next minute** to pick up
 * the remainder, repeating until nothing is deferred. Once everything is fresh
 * it relaxes into a slow, rate-limit-friendly cadence and — when the tab is
 * hidden — stops entirely so no credits are wasted in the background.
 */

/** A minute, in ms — the Twelve Data per-minute credit window. */
const MINUTE_MS = 60 * 1000;

/** Small jitter so multiple tabs/devices don't all wake on the same instant. */
const JITTER_MS = 1500;

export interface RefreshCadenceOptions {
  /** Slow steady-state interval (ms) once everything is fresh. */
  slowIntervalMs?: number;
  /** Burst interval (ms) while symbols are still being filled in. */
  burstIntervalMs?: number;
  /** Deterministic jitter for tests; defaults to a small random value. */
  jitterMs?: number;
}

/** The minimal slice of a quote-load report the cadence policy needs. */
export interface RefreshSignal {
  /** Symbols that couldn't be fetched this round (free-tier budget exhausted). */
  deferred: readonly string[];
}

export const DEFAULT_SLOW_INTERVAL_MS = 5 * MINUTE_MS;
export const DEFAULT_BURST_INTERVAL_MS = MINUTE_MS;

/**
 * How long to wait before the next auto-refresh, given what the last refresh
 * managed to do.
 *
 * - **Still deferring symbols** → burst: wait ~one minute (the per-minute credit
 *   window) so the next round can fetch the symbols we couldn't afford this time.
 *   This is the "fill in everything ASAP on startup" behaviour.
 * - **Nothing deferred** → everything reachable is fresh, so relax to the slow
 *   steady-state cadence and stop spending credits aggressively.
 */
export function nextRefreshDelayMs(signal: RefreshSignal, options: RefreshCadenceOptions = {}): number {
  const {
    slowIntervalMs = DEFAULT_SLOW_INTERVAL_MS,
    burstIntervalMs = DEFAULT_BURST_INTERVAL_MS,
    jitterMs = Math.floor(Math.random() * JITTER_MS),
  } = options;
  const base = signal.deferred.length > 0 ? burstIntervalMs : slowIntervalMs;
  return base + jitterMs;
}
