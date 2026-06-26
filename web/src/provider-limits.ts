/**
 * Single source of truth for the **data-provider rate limits** the live-data
 * layer budgets against. These used to be hard-coded module constants scattered
 * across `quotes.ts`, `tiingo-gate.ts` and `compute.ts`; they now live here so
 * the Settings screen can lower them (e.g. to share one free tier across several
 * devices) without any value being duplicated anywhere else.
 *
 * Two metered providers are arbitrated:
 *
 *  - **Twelve Data** (primary quotes) — free tier is 8 credits/min, 800/day,
 *    1 credit per symbol.
 *  - **Tiingo** (secondary / fallback) — the shared account is split 80 % web,
 *    so the web side self-caps at 40/hr · 800/day.
 *
 * The {@link DEFAULT_PROVIDER_LIMITS} are the documented free-tier ceilings: the
 * recommended values for a free account. The Settings UI defaults to them and
 * recommends them for the free tier, but does **not** force them — a user on a
 * paid plan may raise a limit above its free-tier value so the app spends their
 * larger allowance.
 *
 * The values are held in a small mutable store seeded from per-device config at
 * startup ({@link setProviderLimits}). Consumers that need them dynamically
 * register a {@link onProviderLimitsChange} subscriber, so the existing
 * `FREE_TIER` / `WEB_*_CAP` exports keep working as live numbers without every
 * call site having to thread the values through.
 */

/** The configurable rate limits for the two metered data providers. */
export interface ProviderLimits {
  /** Twelve Data credits allowed per rolling minute. */
  twelveDataPerMinute: number;
  /** Twelve Data credits allowed per rolling day. */
  twelveDataPerDay: number;
  /** Tiingo credits allowed per clock hour (web's 80 % share). */
  tiingoPerHour: number;
  /** Tiingo credits allowed per ET day (web's 80 % share). */
  tiingoPerDay: number;
}

/**
 * The documented free-tier values — the recommended limits for a free account.
 * Settings defaults to these and recommends them for the free tier, but allows
 * going higher (a paid plan) or lower (sharing one account across more devices).
 */
export const DEFAULT_PROVIDER_LIMITS: ProviderLimits = {
  twelveDataPerMinute: 8,
  twelveDataPerDay: 800,
  tiingoPerHour: 40,
  tiingoPerDay: 800,
} as const;

let current: ProviderLimits = { ...DEFAULT_PROVIDER_LIMITS };

type Subscriber = (limits: ProviderLimits) => void;
const subscribers: Subscriber[] = [];

/** The provider limits currently in force (defaults until config seeds them). */
export function providerLimits(): ProviderLimits {
  return current;
}

/**
 * Replace the in-force provider limits (called once at startup from config, and
 * again whenever Settings saves) and notify every subscriber so the live
 * `FREE_TIER` / `WEB_*_CAP` mirrors update in lock-step.
 */
export function setProviderLimits(limits: ProviderLimits): void {
  current = { ...limits };
  for (const fn of subscribers) fn(current);
}

/** Restore the documented free-tier defaults (used by tests for isolation). */
export function resetProviderLimits(): void {
  setProviderLimits({ ...DEFAULT_PROVIDER_LIMITS });
}

/**
 * Register a callback fired immediately with the current limits and again on
 * every {@link setProviderLimits}. Lets a module expose a live numeric mirror
 * (e.g. `WEB_HOURLY_CAP`) that always reflects the configured value.
 */
export function onProviderLimitsChange(fn: Subscriber): void {
  subscribers.push(fn);
  fn(current);
}
