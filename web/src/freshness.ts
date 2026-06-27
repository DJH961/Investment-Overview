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

import { isForexMarketOpen, lastForexReopenMs } from "./market-hours";

/** One clock hour, in ms — the Twelve Data / Tiingo hourly reset cadence. */
export const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * The "just opened" boundary: a market that has been open for less than this has
 * no settled intraday bar worth pulling yet, so the table falls back to
 * quotes + breadcrumbs (no bars) until it is crossed.
 */
export const MARKET_WARMUP_MS = 30 * 60 * 1000;

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
  /**
   * The session EUR→USD **open/close bar track** that anchors the hero currency
   * KPI's market-hours/overnight split. A cheap one-shot pull (Tiingo `/price`
   * fxHistory) the orchestrator owns as a first-class leg rather than an ad-hoc
   * after-hours side pipeline — see {@link ../session-fx.sessionFxAnchorMissing}.
   */
  fxBars: boolean;
}

/** No-op leg set — the "nothing to pull" answer. */
export function noLegs(): PullLegs {
  return { weekBars: false, dayBars: false, quotes: false, nav: false, fx: false, fxBars: false };
}

/** Every leg on — the heavily-outdated / reset answer. */
export function allLegs(): PullLegs {
  return { weekBars: true, dayBars: true, quotes: true, nav: true, fx: true, fxBars: true };
}

/** Whether a leg set asks for any network at all. */
export function hasAnyLeg(legs: PullLegs): boolean {
  return legs.weekBars || legs.dayBars || legs.quotes || legs.nav || legs.fx || legs.fxBars;
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
 * Rolling quote freshness: whether a quote is due given the last fetch instant.
 * The window is the **user-set auto-refresh interval** (`autoIntervalMs` from
 * config), so lowering the refresh rate immediately speeds up quote updates.
 * Independent of the clock-hour bar gate.
 */
export function quoteRefreshDue(
  lastQuoteMs: number,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - lastQuoteMs >= ttlMs;
}

/**
 * Per-row freshness tier for a single holding's displayed price — the three-way
 * split the freshness-plan §2 calls for, mirroring the FX rate's cache→live
 * cache→live promotion but with an explicit middle "recent" rung:
 *
 *   - `live`   — the market is open and the price was observed within one live
 *                window (the user-set auto-refresh interval); a spot confirmed
 *                moments ago is, to the user, as live as one re-pulled this round.
 *   - `recent` — observed today but older than the live window, or observed
 *                within the window while the market is **shut** (a confirmed value
 *                that is current but not a live intraday mark).
 *   - `aged`   — no live/cached observation (the price came from the export), or
 *                the newest observation is from an earlier calendar day. The row
 *                then shows its honest "as of <date/time>" instead of a status word.
 *
 * Pure and clock-injected so it is unit-testable in isolation.
 */
export type RowFreshness = "live" | "recent" | "aged";

export interface RowFreshnessInput {
  /** Epoch ms the displayed price was observed, or null when from the export. */
  observedAtMs: number | null;
  /** Decision instant, epoch ms. */
  nowMs: number;
  /** Whether the holding's market is open right now. */
  marketOpen: boolean;
  /** The live window (ms) — the user-set auto-refresh interval. */
  liveWindowMs: number;
  /**
   * Epoch ms of the latest settled session's close (e.g. NYSE 16:00 ET).
   * An observation at or after this time is considered "today's price" regardless
   * of the local calendar day — prevents false "aged" after midnight local when
   * the observation IS the latest market close. Optional for backward compat.
   */
  lastSettledCloseMs?: number;
}

/** Whether two epoch-ms instants fall on the same local calendar day. */
function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Classify a holding's displayed price into a {@link RowFreshness} tier. */
export function holdingFreshness(input: RowFreshnessInput): RowFreshness {
  const { observedAtMs, nowMs, marketOpen, liveWindowMs, lastSettledCloseMs } = input;
  if (observedAtMs === null) return "aged";
  const window = liveWindowMs > 0 ? liveWindowMs : ONE_HOUR_MS;
  const age = nowMs - observedAtMs;
  // A future-stamped observation (clock skew) cannot read as live, mirroring the
  // headline badge's `liveFeedAge >= 0` guard.
  const withinWindow = age >= 0 && age <= window;
  if (marketOpen && withinWindow) return "live";
  // Confirmed today (or within the window while shut) but not a live intraday
  // mark: "recent". An observation from an earlier day is genuinely "aged".
  // Use the settled-close boundary when supplied — a price at or after the latest
  // session close is "today's price" regardless of the local calendar day (fixes
  // the midnight-local false-aged bug for non-US timezones).
  const isToday = lastSettledCloseMs !== undefined
    ? observedAtMs >= lastSettledCloseMs
    : sameLocalDay(observedAtMs, nowMs);
  if (withinWindow || isToday) return "recent";
  return "aged";
}

/**
 * Layer-6 FX freshness tier for the displayed EUR/USD rate. A superset of
 * {@link RowFreshness} with two FX-only rungs:
 *
 *   - `none` — no rate held at all (book values may be incomplete).
 *   - `eod`  — a *keyless* end-of-day rate: a rate is held but carries no
 *              observation instant (e.g. a static EOD source), so it is honestly
 *              "end of day" and can never grade as a live/recent intraday mark.
 *   - `live` / `recent` / `aged` — graded exactly like a holding via
 *              {@link holdingFreshness}, but against the **forex** market clock
 *              (nearly 24×5, see {@link isForexMarketOpen}) and the most recent
 *              forex weekly reopen as the settled boundary.
 */
export type FxFreshness = "live" | "recent" | "aged" | "eod" | "none";

/** Inputs to {@link fxFreshness}. */
export interface FxFreshnessInput {
  /** Whether any EUR/USD rate is held at all (false ⇒ `"none"`). */
  hasRate: boolean;
  /**
   * Epoch ms the held rate was observed, or `null` for a *keyless* end-of-day
   * rate (a rate with no observation instant ⇒ `"eod"`).
   */
  fxObservedAt: number | null;
  /** Decision instant. */
  now: Date;
  /** The live window (ms) — the user-set auto-refresh interval. */
  intervalMs: number;
}

/**
 * Classify the displayed EUR/USD rate into an {@link FxFreshness} tier. Wraps
 * {@link holdingFreshness} so the three graded rungs mirror a holding row's
 * exactly, then adds the FX-only `"none"` and `"eod"` answers. Pure and
 * clock-injected (the forex market state is derived from `now`), so it is
 * unit-testable in isolation.
 */
export function fxFreshness(input: FxFreshnessInput): FxFreshness {
  if (!input.hasRate) return "none";
  // A keyless end-of-day rate carries no observation instant, so it cannot be
  // graded live/recent — it is honestly "end of day".
  if (input.fxObservedAt === null) return "eod";
  return holdingFreshness({
    observedAtMs: input.fxObservedAt,
    nowMs: input.now.getTime(),
    marketOpen: isForexMarketOpen(input.now),
    liveWindowMs: input.intervalMs,
    lastSettledCloseMs: lastForexReopenMs(input.now),
  });
}

/**
 * The **absolute** "is this holding up to date?" driver behind the subtle
 * up-to-date check mark on each holding card (suggestion #1 + #4).
 *
 * Where {@link holdingFreshness} grades *how recently* a price was observed, this
 * answers the orthogonal, calendar-anchored question the after-close / pre-open
 * "stale market" window actually poses: **does this holding already carry the
 * latest settled session's close that it ought to?** It compares the price's own
 * value-date against the most recent settled NYSE session — so it is true the
 * moment a holding has repriced onto that session and false while it still trails
 * behind, regardless of the wall-clock age of the observation.
 *
 * It deliberately works off the displayed price's **value-date** (an ISO
 * `YYYY-MM-DD`, lexicographically comparable), which both market quotes and
 * once-a-day NAV bars carry, so it accounts for the two price kinds uniformly:
 *   - **market symbols** (stocks / ETFs): the latest session's close lands at the
 *     bell; a row carrying it (value-date ≥ the settled session) reads current.
 *   - **NAV funds** (mutual funds): a fund publishes ~once a day, often hours
 *     after the close, so right after the bell its newest bar is still the prior
 *     session and it honestly reads *behind* until the new NAV is pulled — exactly
 *     the "this fund hasn't updated yet" signal the morning view wants.
 *
 * Par-$1 money-market funds never move and are never fetched, so they are always
 * considered current. A holding with no value at all (no price/FX/fallback) is
 * never current — there is nothing to be up to date about.
 *
 * Pure and free of the DOM / clock so it is unit-testable in isolation; the
 * market-state gate that decides *whether to paint* the check lives in the view.
 */
export interface CoversLatestCloseInput {
  /** ISO `YYYY-MM-DD` value-date the displayed price applies to. */
  priceDateIso: string;
  /** ISO `YYYY-MM-DD` of the most recent settled session the book should carry. */
  latestSettledSessionIso: string;
  /** Whether this holding is a par-$1 money-market fund (never moves). */
  isMoneyMarket?: boolean;
  /** Whether a value could be computed at all (false ⇒ nothing to be current about). */
  hasValue?: boolean;
}

/** Whether a holding's displayed price already covers the latest settled close. */
export function holdingCoversLatestClose(input: CoversLatestCloseInput): boolean {
  if (input.hasValue === false) return false;
  // Par-$1 money-market funds hold a constant NAV and are never fetched, so they
  // can never be "behind" a session — always current.
  if (input.isMoneyMarket) return true;
  if (!input.priceDateIso || !input.latestSettledSessionIso) return false;
  // ISO dates sort lexicographically, so a string compare is a date compare.
  return input.priceDateIso >= input.latestSettledSessionIso;
}
