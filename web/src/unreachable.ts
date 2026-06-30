/**
 * Honest reporting + sane pacing for a round where **no price service could be
 * reached** (`classifyConnectivity` returned `"unreachable"`).
 *
 * Two long-standing pains motivate this module:
 *
 *   1. **The non-stop "Updating…" loop.** When every provider is unreachable the
 *      round still *defers* its symbols, and the burst scheduler treats a deferred
 *      symbol as "fill me in next minute" — so it re-bursts every ~60 s forever,
 *      flashing the spinner and burning wake-ups against a provider that has
 *      already said "no". {@link unreachableBackoffMs} replaces that blind burst
 *      with an exponential back-off so a genuine outage settles down quickly while
 *      still recovering promptly the instant a service answers again.
 *
 *   2. **An opaque banner.** "Couldn't reach any price service" never said *why*.
 *      {@link describeUnreachable} turns the providers' own {@link PriceError}s
 *      into one greppable line — each provider's HTTP status, its verbatim message
 *      and a plain classification (rate-limited / bad key / server error / no
 *      response) — so the polling log explains the outage instead of just noting
 *      it.
 *
 * Pure and dependency-light (only the {@link PriceError} type) so it is unit
 * tested in isolation (`web/test/unreachable.test.ts`); the caller (`app.ts`)
 * owns the clock, the scheduler and the polling log.
 */

import type { PriceError } from "./prices";

/** A minute, in ms. */
const MINUTE_MS = 60 * 1000;

/** Default first back-off step once a round is found unreachable. */
export const DEFAULT_UNREACHABLE_BASE_MS = MINUTE_MS;

/**
 * Default ceiling for the unreachable back-off. A provider outage should not
 * leave the dashboard checking more than once every ~15 minutes — frequent
 * enough that recovery is noticed soon after it happens, rare enough that a long
 * outage is not a busy-loop. (The `online`/`visibilitychange` listeners still
 * pull immediately when the link or the tab genuinely returns, so this only
 * bounds the *background* poll while nothing has changed.)
 */
export const DEFAULT_UNREACHABLE_MAX_MS = 15 * MINUTE_MS;

/**
 * How long to wait before the next automatic refresh after a round that reached
 * **no** price service, given how many consecutive unreachable rounds have now
 * occurred (`1` for the first).
 *
 * The delay doubles each round — `base`, `2·base`, `4·base`, … — capped at
 * `maxMs`, so a one-off blip retries quickly (a minute) while a sustained outage
 * settles to the ceiling instead of bursting every minute. Returns `base` for
 * any `rounds ≤ 1` (the first unreachable round, or a nonsensical count), and is
 * always at least `base`.
 *
 * This is deliberately *separate* from the budget-deferral burst: a deferred
 * symbol that a provider simply hadn't the credits for this minute genuinely
 * wants the next-minute burst; a symbol no provider could be *reached* for does
 * not — retrying in 60 s just repeats the failure. The caller picks this delay
 * only when the round's connectivity verdict is `"unreachable"`.
 */
export function unreachableBackoffMs(
  rounds: number,
  opts: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = opts.baseMs ?? DEFAULT_UNREACHABLE_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_UNREACHABLE_MAX_MS;
  if (!Number.isFinite(rounds) || rounds <= 1) return Math.min(baseMs, maxMs);
  // Double each consecutive round: rounds=1 → base, 2 → 2·base, 3 → 4·base, …
  const factor = 2 ** (rounds - 1);
  const delay = baseMs * factor;
  if (!Number.isFinite(delay)) return maxMs;
  return Math.min(delay, maxMs);
}

/**
 * Classify a single provider's failure into a short, human reason — the same
 * vocabulary the Settings probe uses, so the log and the probe agree on what a
 * status means. `null` (the provider didn't fail / wasn't tried) returns null.
 */
function classifyProviderError(error: PriceError | null): string | null {
  if (error === null) return null;
  if (error.status === 429) return "rate-limited (HTTP 429) — quota looks spent";
  if (error.status === 401 || error.status === 403)
    return `bad/over-quota API key (HTTP ${error.status})`;
  if (error.status !== null && error.status >= 500)
    return `server error (HTTP ${error.status})`;
  if (error.status !== null) return `HTTP ${error.status}`;
  // No status at all ⇒ the request never got a response (DNS/CORS/offline/proxy
  // down): a transport failure, the most opaque case the banner used to hide.
  return "no response (network/proxy unreachable)";
}

/**
 * One verbose, greppable line explaining **why** a round reached no price
 * service and what each provider reported — for the polling log and to enrich
 * the degradation banner. Names each provider that failed with its HTTP status,
 * its classification and its verbatim message, so the trail says exactly what
 * happened rather than a bare "couldn't reach any price service".
 *
 * Returns `null` when neither provider actually errored (so the caller never
 * logs an empty "unreachable" line for a round that was merely up to date).
 */
export function describeUnreachable(
  quoteError: PriceError | null,
  tiingoError: PriceError | null,
): string | null {
  const parts: string[] = [];
  const primary = classifyProviderError(quoteError);
  if (primary !== null && quoteError !== null) {
    parts.push(`Primary (Twelve Data): ${primary} — "${quoteError.message}"`);
  }
  const backup = classifyProviderError(tiingoError);
  if (backup !== null && tiingoError !== null) {
    parts.push(`Backup (Tiingo): ${backup} — "${tiingoError.message}"`);
  }
  if (parts.length === 0) return null;
  return `No price service reachable this round. ${parts.join(" ")}`;
}
