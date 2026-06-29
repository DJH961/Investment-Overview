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

/**
 * Floor for the {@link minuteBudgetReliefMs credit-aware burst}. A credit on the
 * verge of ageing out could otherwise schedule the next burst within a few ms of
 * `now`; this keeps a small gap so the refresh loop can't spin hot.
 */
export const MIN_BURST_RELIEF_MS = 2_000;

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
  /**
   * Credits left in the rolling **daily** window (Twelve Data free tier: 800/day).
   * Omit to disable daily-budget pacing. As this shrinks the cadence stretches
   * out so the remaining budget lasts the rest of the day instead of being burnt
   * early; at zero, auto-refresh backs right off.
   */
  dayRemaining?: number;
  /** Total daily credit budget; defaults to {@link DEFAULT_DAY_CREDIT_LIMIT}. */
  dayLimit?: number;
}

export const DEFAULT_SLOW_INTERVAL_MS = 5 * MINUTE_MS;
export const DEFAULT_BURST_INTERVAL_MS = MINUTE_MS;

/** Twelve Data free-tier daily credit cap (1 credit/symbol). */
export const DEFAULT_DAY_CREDIT_LIMIT = 800;

/**
 * Fraction of the daily budget that may be spent before the cadence starts to
 * stretch. Below this we refresh at the normal burst/slow cadence; above it we
 * progressively space refreshes out so the rest of the budget lasts the day.
 */
export const BUDGET_EASE_THRESHOLD = 0.75;

/**
 * Hardest the daily-budget backoff stretches the cadence (multiplier on the base
 * interval) as the budget nears or reaches exhaustion. e.g. the 5-minute slow
 * cadence relaxes towards ~40 minutes once almost no daily credits remain.
 */
export const MAX_BUDGET_SLOWDOWN = 8;

/**
 * How much to stretch the refresh cadence given the daily credit budget left.
 *
 * Returns a multiplier ≥ 1 applied to the base (burst/slow) interval: `1` while
 * plenty of the daily budget remains, ramping up to {@link MAX_BUDGET_SLOWDOWN}
 * as spend approaches the cap, and pinned at the max once nothing is left. This
 * is what makes refreshes "space out automatically the closer we get to the
 * limit" so a heavy day doesn't exhaust the free tier before the day is out.
 */
export function dailyBudgetSlowdown(dayRemaining?: number, dayLimit = DEFAULT_DAY_CREDIT_LIMIT): number {
  if (dayRemaining === undefined || !Number.isFinite(dayRemaining) || dayLimit <= 0) return 1;
  if (dayRemaining <= 0) return MAX_BUDGET_SLOWDOWN;
  const used = 1 - Math.min(1, dayRemaining / dayLimit);
  if (used <= BUDGET_EASE_THRESHOLD) return 1;
  // Linear ramp from 1× at the ease threshold to MAX× at full exhaustion.
  const t = (used - BUDGET_EASE_THRESHOLD) / (1 - BUDGET_EASE_THRESHOLD);
  return 1 + t * (MAX_BUDGET_SLOWDOWN - 1);
}

/**
 * How long to wait before the next auto-refresh, given what the last refresh
 * managed to do.
 *
 * - **Still deferring symbols** → burst: wait ~one minute (the per-minute credit
 *   window) so the next round can fetch the symbols we couldn't afford this time.
 *   This is the "fill in everything ASAP on startup" behaviour.
 * - **Nothing deferred** → everything reachable is fresh, so relax to the slow
 *   steady-state cadence and stop spending credits aggressively.
 *
 * Either base is then stretched by {@link dailyBudgetSlowdown} as the rolling
 * daily credit budget runs low, so a long session paces itself instead of
 * blowing the whole free-tier allowance early.
 */
/**
 * Floor for the "jumpstart" cadence. After a fetch-less round we may bring the
 * next automatic refresh forward to land exactly when the oldest *still-fresh*
 * value reaches the auto-update window (see {@link jumpstartDelayMs}). This is
 * the soonest such a jumpstart may ever schedule, so a value sitting right on
 * the edge of its window can't collapse the delay toward ~0 and spin the
 * refresh loop hot.
 */
export const MIN_JUMPSTART_DELAY_MS = MINUTE_MS;

/**
 * How long to wait for the "jumpstart" refresh — the next automatic pull after a
 * round that fetched nothing because everything was still fresh — given the
 * observation time of the **oldest still-fresh** value.
 *
 * Returns the ms until that value first reaches the auto-update window, floored
 * by {@link MIN_JUMPSTART_DELAY_MS}; or `null` when the jumpstart can't be
 * anchored and the normal cadence should be used instead. Crucially it returns
 * `null` (not `0`) when the oldest value is **already at or past** the window:
 * such a value is no longer "still fresh", so it can't anchor a *future*
 * jumpstart. Returning `0` there would re-fire the refresh immediately, and when
 * the round deliberately holds that value within its own (longer) freshness
 * window — e.g. an FX rate older than a short auto-update interval — its age
 * never advances, so the next round computes `0` again: a 0-millisecond runaway
 * loop. Deferring to the normal scheduler instead keeps the cadence sane.
 */
export function jumpstartDelayMs(
  oldestFreshAtMs: number | null,
  intervalMs: number,
  nowMs: number,
): number | null {
  if (oldestFreshAtMs === null) return null;
  const remaining = oldestFreshAtMs + intervalMs - nowMs;
  // Already at/past the window — not "still fresh", so don't anchor (and never
  // collapse to 0). Let the normal scheduler decide the next pull.
  if (remaining <= 0) return null;
  // Never schedule the jumpstart sooner than the burst floor.
  return Math.max(remaining, MIN_JUMPSTART_DELAY_MS);
}

/**
 * Reload-debounce window: how recently a login prefetch must have run for the
 * next page-load to skip warming again. Set to **half the auto-update cycle**, so
 * a fingerprint fumble, a wrong-passphrase retry, or the constant
 * reload-to-bust-the-cache-for-a-new-version dance never re-spends credits — yet
 * a deliberate return after a real gap still warms. Clamped to the burst floor so
 * a sub-minute interval can't disable the gate entirely.
 */
export function prefetchDebounceMs(intervalMs: number): number {
  return Math.max(MIN_JUMPSTART_DELAY_MS, Math.round(intervalMs / 2));
}

/**
 * Whether a fresh login prefetch should be **skipped** because one already ran
 * within {@link prefetchDebounceMs half the auto-update cycle}. The shortened
 * first auto-update is preserved by the jumpstart cadence ({@link jumpstartDelayMs}),
 * which anchors on the oldest still-fresh value — so a debounced reload still
 * refreshes exactly when that value is about to age out, just without a duplicate
 * warm-up. Returns false (warm now) when no prior prefetch is recorded or the
 * stamp is in the future (clock skew).
 */
export function prefetchDebounceActive(
  lastPrefetchAtMs: number | null,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (lastPrefetchAtMs === null) return false;
  const since = nowMs - lastPrefetchAtMs;
  if (since < 0) return false;
  return since < prefetchDebounceMs(intervalMs);
}

/**
 * How many auto-update intervals an in-flight refresh round may run before it is
 * presumed **hung** and may be abandoned. A round normally completes in well
 * under one interval; one that has been "in flight" for several is almost always
 * a frozen timer/`fetch` that the OS suspended when the device slept mid-round
 * (the log-44 case: a 16:37 round resumed and *completed* at 17:36, an hour
 * later, stamping stale work as fresh). Tied to the user's own setting so a long
 * configured cadence tolerates a proportionally longer round.
 */
export const STALE_ROUND_INTERVAL_MULTIPLIER = 3;

/**
 * Floor for {@link staleRoundAbortMs} so a very short auto-update interval still
 * gives an honestly-slow round (a big portfolio fanning out over the backup,
 * say) enough time to finish before it is judged hung.
 */
export const MIN_STALE_ROUND_ABORT_MS = 90_000;

/**
 * How long an in-flight refresh round may run before it counts as hung — the
 * user's configured auto-update interval times {@link STALE_ROUND_INTERVAL_MULTIPLIER},
 * floored by {@link MIN_STALE_ROUND_ABORT_MS}. The scheduler ties its stale-round
 * abort to this so the watchdog scales with the setting rather than a magic
 * constant.
 */
export function staleRoundAbortMs(intervalMs: number): number {
  const base = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  return Math.max(MIN_STALE_ROUND_ABORT_MS, Math.round(base * STALE_ROUND_INTERVAL_MULTIPLIER));
}

/**
 * Whether a refresh round that began at `startedAtMs` has been in flight long
 * enough ({@link staleRoundAbortMs}) to be presumed hung and safe to abandon.
 *
 * Returns false when there is no round in flight (`startedAtMs === null`) or the
 * stamp is in the future / now (clock skew), so a freshly-started round is never
 * mistaken for a stale one. This is what lets a wake-up *replace* a suspended
 * round with a fresh pull instead of waiting on — then completing — hour-old work.
 */
export function roundIsStale(startedAtMs: number | null, nowMs: number, intervalMs: number): boolean {
  if (startedAtMs === null) return false;
  const age = nowMs - startedAtMs;
  if (age <= 0) return false;
  return age >= staleRoundAbortMs(intervalMs);
}

/**
 * Default window in which repeated "the app woke up" triggers collapse to a
 * single refresh — see {@link wakeCoalesceActive}. A resume commonly fires
 * `visibilitychange`, `pageshow`, `focus`, *and* `online` within a beat of each
 * other (plus a post-unlock kickoff and a resumed timer): in log 44 three
 * back-to-back warm-ups/kickoffs fanned out over the same 4-second wake,
 * double-spending the per-minute budget and forcing the "real" pull to defer.
 */
export const DEFAULT_WAKE_COALESCE_MS = 5_000;

/**
 * Whether a wake-driven refresh should be **suppressed** because another already
 * ran within {@link DEFAULT_WAKE_COALESCE_MS} — the debounce that collapses the
 * resume "storm" (visibility + pageshow + focus + online, all firing at once)
 * into one pull. Returns false (let it run) when no prior wake is recorded or the
 * stamp is in the future (clock skew), so the first wake of a genuine return
 * always pulls.
 */
export function wakeCoalesceActive(
  lastWakeAtMs: number | null,
  nowMs: number,
  windowMs = DEFAULT_WAKE_COALESCE_MS,
): boolean {
  if (lastWakeAtMs === null) return false;
  const since = nowMs - lastWakeAtMs;
  if (since < 0) return false;
  return since < windowMs;
}

/**
 * Human caption for the *continuous* "auto-updating" pill while a portfolio too
 * big for one free-tier minute fills in over several catch-up rounds. Keeping a
 * single pill (whose text this updates in place) instead of tearing it down and
 * rebuilding it each round is what stops the spinner animation restarting on
 * every burst — the "multiple auto-update animations" the user flagged. Returns
 * `""` when nothing is left to fill in, so the caller can take the pill down.
 */
export function burstFillDetail(remaining: number): string {
  if (!Number.isFinite(remaining) || remaining <= 0) return "";
  return remaining === 1 ? "1 holding still filling in" : `${remaining} holdings still filling in`;
}

/**
 * Credit-aware burst relief — how long until the Twelve Data per-minute window
 * frees its **next** credit, given the timestamps (epoch-ms) of the credits
 * spent so far.
 *
 * The per-minute budget is a *trailing* 60-second window: a credit spent at `T`
 * stops counting against the cap at `T + windowMs`. When a round defers symbols
 * purely because that window is full, the soonest another symbol can be fetched
 * is when the **oldest** in-window spend ages out — which, if some of those
 * credits were spent by an *earlier* round (e.g. the startup pull moments before
 * a force/reset), is sooner than a blind fresh minute. Returns that ms (floored
 * by `floorMs` so a just-expiring credit can't collapse the burst toward 0 and
 * spin hot), or `null` when nothing is in the window (no per-minute relief is
 * owed, so the caller keeps its normal cadence).
 */
export function minuteBudgetReliefMs(
  spendTimesMs: readonly number[],
  nowMs: number,
  windowMs = MINUTE_MS,
  floorMs = 0,
): number | null {
  let oldestInWindow: number | null = null;
  for (const t of spendTimesMs) {
    if (nowMs - t < windowMs && (oldestInWindow === null || t < oldestInWindow)) {
      oldestInWindow = t;
    }
  }
  if (oldestInWindow === null) return null;
  return Math.max(oldestInWindow + windowMs - nowMs, floorMs);
}

/**
 * Credit-aware burst relief, made to **cooperate with the 429 circuit breaker**.
 *
 * Thin wrapper over {@link minuteBudgetReliefMs} that additionally honours the
 * provider's 429 freeze: when `frozen` is true (the Twelve Data breaker has
 * tripped — see `provider-breaker.ts`), it returns `null` so the caller keeps its
 * normal, also-breaker-gated cadence instead of bringing the burst forward. A
 * freeze forces the per-minute budget to 0, so an early relief wake-up could not
 * fetch anything — it would only wake, re-defer, and (until the local credit
 * ledger ages out) potentially reschedule, burning wake-ups against a provider
 * that has already said "no". Suppressing relief while frozen is what makes the
 * two mechanisms cooperate: the next pull lands no sooner than it could actually
 * succeed. When not frozen, behaviour is identical to {@link minuteBudgetReliefMs}.
 */
export function burstReliefMs(
  spendTimesMs: readonly number[],
  nowMs: number,
  opts: { frozen?: boolean; windowMs?: number; floorMs?: number } = {},
): number | null {
  if (opts.frozen) return null;
  return minuteBudgetReliefMs(spendTimesMs, nowMs, opts.windowMs ?? MINUTE_MS, opts.floorMs ?? 0);
}

export function nextRefreshDelayMs(signal: RefreshSignal, options: RefreshCadenceOptions = {}): number {
  const {
    slowIntervalMs = DEFAULT_SLOW_INTERVAL_MS,
    burstIntervalMs = DEFAULT_BURST_INTERVAL_MS,
    jitterMs = Math.floor(Math.random() * JITTER_MS),
  } = options;
  const base = signal.deferred.length > 0 ? burstIntervalMs : slowIntervalMs;
  const slowdown = dailyBudgetSlowdown(signal.dayRemaining, signal.dayLimit);
  return Math.round(base * slowdown) + jitterMs;
}
