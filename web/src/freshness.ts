/**
 * Pillar 4 — the graded-freshness truth-table, the clock-hour 1D-bar gate, and
 * the rolling quote TTL, all as **pure** decision functions.
 *
 * This is the policy half of the "one readable brain" (`data-orchestrator.ts`):
 * given the device's data age, the *best-available* blob recency (from blob
 * **metadata**, never the on-device blob's age), the market state and the
 * configured refresh interval, it decides **what** to pull and **when** — and
 * nothing about *which provider* serves it (that is Pillar 5, kept orthogonal).
 *
 * Everything here is side-effect-free and clock-injected, so the survival rules
 * of the pull loop are testable in isolation (`web/test/freshness.test.ts`).
 *
 * See `docs/centralized_data_pull_plan.md` §"Pillar 4 — Graded freshness
 * truth-table".
 */

/** One clock hour, in ms — the Twelve Data / Tiingo hourly reset cadence. */
export const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * The "just opened" boundary: a market that has been open for less than this has
 * no settled intraday bar worth pulling yet, so the table falls back to
 * quotes + breadcrumbs (no bars) until it is crossed.
 */
export const MARKET_WARMUP_MS = 30 * 60 * 1000;

/**
 * Rolling quote freshness window (15 min) — mirrors `quotes.ts`
 * `DEFAULT_CACHE_TTL_MS`. Quotes refresh on this rolling cadence for a live feel,
 * independent of the (clock-hour-aligned) bar gate. Kept as a local constant so
 * this pure policy module pulls in none of the heavy fetch plumbing.
 */
export const QUOTE_ROLLING_TTL_MS = 15 * 60 * 1000;

/** Whether the regular US session is open or closed at the decision instant. */
export type MarketPhase = "open" | "closed";

/**
 * The graded tier the truth-table lands on. Ordered roughly most- to
 * least-stale; `"fresh"` means "fresher than one auto-interval — pull nothing".
 */
export type FreshnessTier =
  | "heavily-outdated"
  | "minorly-outdated"
  | "relatively-fresh"
  | "fresh";

/**
 * The legs a pull may run. Each is an independent yes/no; *which provider* serves
 * a `true` leg is decided downstream (Pillar 5), never here.
 */
export interface PullLegs {
  /** Full 1W (daily-close) series for every market symbol. */
  weekBars: boolean;
  /** 1D (intraday) bar series. */
  dayBars: boolean;
  /** Live per-symbol quotes (rolling-TTL gated). */
  quotes: boolean;
  /** NAV-fund quote (mutual funds — publishes ~once a day). */
  nav: boolean;
  /** EUR/USD FX rate. */
  fx: boolean;
}

/** No-op leg set — the "nothing to pull" answer. */
export function noLegs(): PullLegs {
  return { weekBars: false, dayBars: false, quotes: false, nav: false, fx: false };
}

/** Every leg on — the heavily-outdated / reset answer. */
export function allLegs(): PullLegs {
  return { weekBars: true, dayBars: true, quotes: true, nav: true, fx: true };
}

/** Whether a leg set asks for any network at all. */
export function hasAnyLeg(legs: PullLegs): boolean {
  return legs.weekBars || legs.dayBars || legs.quotes || legs.nav || legs.fx;
}

/** Inputs to {@link gradedPull}. All ages are in ms; all clocks injected. */
export interface FreshnessInputs {
  /** Age of the freshest device price data (newest quote/bar), in ms. */
  dataAgeMs: number;
  /**
   * Whole market days of price data **missing on the device** (0 = up to date,
   * 1 = a single session behind, >1 = heavily behind).
   */
  deviceDaysMissing: number;
  /**
   * Whole market days the **best-available** blob trails by, read from blob
   * *metadata* (timestamp + coverage) — **not** the on-device blob's age. This is
   * the prediction signal: a fresh remote blob that covers the gap is downloaded
   * (cheap, zero per-symbol tokens) instead of spending market credits.
   */
  blobDaysOld: number;
  /** Market open/closed at the decision instant. */
  market: MarketPhase;
  /** Trading time elapsed since this session's open, in ms (0 when closed). */
  minutesSinceOpenMs: number;
  /** Configured user-editable auto-update interval, in ms (default 15 min). */
  autoIntervalMs: number;
  /** Whether today's NAV prices are already held (governs the closed-NAV row). */
  navHeldForToday: boolean;
}

/** The truth-table's answer: a tier plus the legs it implies. */
export interface GradedPull {
  tier: FreshnessTier;
  legs: PullLegs;
}

/**
 * The Pillar-4 graded-freshness truth-table as one pure function. Applies to the
 * `start` / `manual` / `reset` mechanisms (the steady `auto` cadence layers the
 * overlays in {@link applyPullGates}).
 *
 * | Tier | Condition | Market | Pull |
 * |---|---|---|---|
 * | heavily-outdated | >1 day missing **and** best blob >1 day old | any | 1W + 1D, full |
 * | minorly-outdated | device **and** best blob ≤1 day old, but >1h | open ≥30m, or closed | 1D series only |
 * | ″ | ″ | open <30m | quotes only (fill 1D from quote + breadcrumbs) |
 * | relatively-fresh | latest <1h but older than one interval | open | market data (quotes + FX) |
 * | ″ | ″ | closed, NAV missing | NAV + FX only |
 * | ″ | ″ | closed, NAV present | FX only |
 * | fresh | fresher than one interval | any | nothing |
 *
 * It decides only *what* and *when*; provider routing is orthogonal (Pillar 5).
 */
export function gradedPull(input: FreshnessInputs): GradedPull {
  // Heavily outdated — we have been away long enough that both our own data and
  // the best blob trail by more than a market day: pull everything.
  if (input.deviceDaysMissing > 1 && input.blobDaysOld > 1) {
    return { tier: "heavily-outdated", legs: allLegs() };
  }

  const olderThanHour = input.dataAgeMs > ONE_HOUR_MS;
  const olderThanInterval = input.dataAgeMs > input.autoIntervalMs;
  const everythingRecent = input.deviceDaysMissing <= 1 && input.blobDaysOld <= 1;

  // Minorly outdated — both sides within a market day, but the latest point is
  // over an hour stale: top up the 1D series (the 1W fills from it).
  if (everythingRecent && olderThanHour) {
    const legs = noLegs();
    if (input.market === "open" && input.minutesSinceOpenMs < MARKET_WARMUP_MS) {
      // Too early in the session for a settled bar: quotes only, the 1D curve
      // accretes from the quote + breadcrumbs until the first bar is due.
      legs.quotes = true;
      legs.fx = true;
      return { tier: "minorly-outdated", legs };
    }
    // Open ≥30 min, or closed: 1D series (bars + quotes), plus FX.
    legs.dayBars = true;
    legs.quotes = true;
    legs.fx = true;
    return { tier: "minorly-outdated", legs };
  }

  // Relatively fresh — under an hour old, but older than one auto-interval, so a
  // light top-up is due. Anything fresher than one interval falls through to
  // "fresh" and pulls nothing (this is what makes a seconds-later re-login a
  // no-op).
  if (olderThanInterval) {
    const legs = noLegs();
    if (input.market === "open") {
      // Live market data: quotes + FX (the bar leg, if any, is governed by the
      // clock-hour overlay, not the table).
      legs.quotes = true;
      legs.fx = true;
      return { tier: "relatively-fresh", legs };
    }
    // Closed: nothing moves intraday. Pull the day's NAV (if still missing) and
    // FX; once NAV is in hand only the FX value can still drift.
    if (!input.navHeldForToday) legs.nav = true;
    legs.fx = true;
    return { tier: "relatively-fresh", legs };
  }

  // Fresher than one interval — leave it alone.
  return { tier: "fresh", legs: noLegs() };
}

/** Inputs to {@link barClockHourDue}. */
export interface BarGateInput {
  /** Decision instant, epoch ms. */
  nowMs: number;
  /**
   * When this symbol's 1D bars were last pulled, epoch ms — or `null` if no bar
   * has been pulled in this session yet (the first-bar case).
   */
  lastBarPullMs: number | null;
  /** This session's 09:30 ET open, epoch ms. */
  sessionOpenMs: number;
  /** Minimum session time before the *first* bar may be pulled (default 1h). */
  firstBarAfterMs?: number;
}

/** Round an epoch-ms instant up to the next clock-hour (`:00`) boundary. */
export function ceilToClockHour(ms: number): number {
  return Math.ceil(ms / ONE_HOUR_MS) * ONE_HOUR_MS;
}

/**
 * The **sole** 1D-bar authority during market hours: a bar is pulled at most once
 * per clock hour per symbol, aligned to `:00` (which also matches Tiingo's hourly
 * reset and naturally dedupes across refreshes and devices).
 *
 * - **First bar of the session** (`lastBarPullMs === null`): allowed only once at
 *   least one bar interval of trading has elapsed since the open, so a 09:30 open
 *   doesn't chase a 10:00 bar off five minutes of trading. This makes the
 *   "open <30 min ⇒ no bars" row fall out for free.
 * - **Subsequent bars**: after a pull at 15:30, the next is allowed at the next
 *   `:00` at or after one hour later — i.e. 17:00, not before. Breadcrumbs fill
 *   the line until then. (There is deliberately **no** mid-hour resume-backfill
 *   trigger; a mid-hour absence is bridged by breadcrumbs until the next `:00`.)
 */
export function barClockHourDue(input: BarGateInput): boolean {
  if (input.lastBarPullMs === null) {
    const firstAfter = input.firstBarAfterMs ?? ONE_HOUR_MS;
    return input.nowMs - input.sessionOpenMs >= firstAfter;
  }
  const nextAllowed = ceilToClockHour(input.lastBarPullMs + ONE_HOUR_MS);
  return input.nowMs >= nextAllowed;
}

/**
 * Rolling quote TTL: whether a fresh quote is due given the last quote instant.
 * Quotes refresh on a rolling 15-minute window for a live feel — independent of
 * the clock-hour bar gate.
 */
export function quoteRefreshDue(
  lastQuoteMs: number,
  nowMs: number,
  ttlMs: number = QUOTE_ROLLING_TTL_MS,
): boolean {
  return nowMs - lastQuoteMs >= ttlMs;
}
