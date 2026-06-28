/**
 * Pillar "provably-complete brain" — the **data-coverage self-check**.
 *
 * The orchestrator (`data-orchestrator.ts`) and the graded-freshness table
 * (`freshness.ts`) decide *what* to pull; this module asks a different,
 * higher-level question and answers it as a **pure** function:
 *
 *   > Under this `(marketCondition, deviceFreshness, blobPresence)`, does
 *   > **every core value** (prices, FX, 1D, 1W, long-range history) still have
 *   > *at least one* load path — an orchestrator leg, the blob, or a
 *   > from-scratch reconstruction?
 *
 * It is the observability companion to the core-vs-bonus registry
 * (`data-registry.ts`): the registry *declares* which stores must be
 * reloadable; this check *proves*, for a given world-state, that each of them
 * actually has a mechanism to load. A missing path is surfaced in the polling
 * log (see {@link summarizeCoverage}) so it is **discoverable** rather than
 * silent.
 *
 * Crucially it encodes the empty-device contract: **only the blob supplies
 * which holdings exist**, so with no blob *and* no prior cache there is nothing
 * to load yet — the verdict reports `awaitingBlob` rather than a defect. Once a
 * blob is present every core value is reachable, because the long-range
 * reconstruction (`long-range.ts`) can always re-fetch multi-month daily bars.
 *
 * Everything here is side-effect-free and input-injected, so the completeness
 * guarantee is testable as a cross-product matrix
 * (`web/test/coverage-check.test.ts`).
 */

/**
 * The market conditions the audit cares about. These are coarser than the live
 * clock — they capture the *kind* of world a load path must survive, not the
 * exact minute.
 */
export type MarketCondition =
  | "pre-open" // a trading day, before the opening bell
  | "open-lt-30m" // open, but inside the warm-up window — no settled intraday bar yet
  | "open-steady" // open and past warm-up — live intraday available
  | "after-close-nav-pending" // a trading day, after the close, NAV not yet published
  | "overnight" // a trading day's night, between sessions
  | "weekend" // Saturday/Sunday — US equities and forex both shut
  | "holiday"; // a US market holiday (equities shut; forex may still trade)

/**
 * How stale (or absent) the device's own caches are. The two terminal tiers —
 * `empty-device` and `first-login-currency-unknown` — carry **no** prior
 * cache, so they depend entirely on the blob to even know the holdings.
 */
export type DeviceFreshness =
  | "fresh"
  | "relatively-fresh"
  | "minorly-outdated"
  | "heavily-outdated"
  | "empty-device" // wiped / brand-new install — no cached stores at all
  | "first-login-currency-unknown"; // first unlock, FX preference not yet resolved

/** Whether a usable encrypted export (blob) is available, and how recent. */
export type BlobPresence =
  | "fresh" // a settled export covering up to the last close
  | "stale" // an older export — present and decryptable, but behind
  | "absent"; // no blob at all (cannot establish holdings on an empty device)

/** The core values every device must be able to reload. Mirrors the registry. */
export type CoreValue = "prices" | "fx" | "oneDay" | "oneWeek" | "longRange";

/**
 * A mechanism that can produce a core value:
 * - `orchestrator` — a live pull leg (quotes/fx/bars) for known holdings.
 * - `blob` — the decrypted export (prices, settled FX, springboard sessions,
 *   analytics curve).
 * - `reconstruction` — rebuilt from scratch by re-fetching bars (long-range) or
 *   re-deriving from stored bars (1D/1W).
 * - `cache` — served straight from a still-warm on-device store.
 */
export type LoadSource = "orchestrator" | "blob" | "reconstruction" | "cache";

/** The world-state the self-check is asked to vouch for. */
export interface CoverageInputs {
  market: MarketCondition;
  freshness: DeviceFreshness;
  blob: BlobPresence;
}

/** Per-core-value verdict: which paths exist, and whether at least one does. */
export interface CoreCoverage {
  value: CoreValue;
  /** Every load path available under the given inputs (possibly empty). */
  sources: LoadSource[];
  /** True iff at least one path exists. */
  covered: boolean;
}

/** The overall completeness verdict for one world-state. */
export interface CoverageVerdict {
  /** Every core value has at least one path (or we are legitimately awaiting the blob). */
  ok: boolean;
  /** Per-core-value breakdown, in a stable order. */
  coverage: CoreCoverage[];
  /** Any core values with no load path at all (empty when `ok`). */
  missing: CoreValue[];
  /**
   * True when there are no holdings yet — no blob *and* no prior cache — so
   * there is genuinely nothing to load. This is the empty-device contract, not
   * a defect: the blob must be decrypted first to establish the holdings.
   */
  awaitingBlob: boolean;
}

/** The order core values are reported in (stable, for logs and tests). */
export const CORE_VALUES: readonly CoreValue[] = [
  "prices",
  "fx",
  "oneDay",
  "oneWeek",
  "longRange",
] as const;

/** Whether US equities trade at all on this kind of day. */
function isEquityTradingDay(market: MarketCondition): boolean {
  return market !== "weekend" && market !== "holiday";
}

/** Whether a *fresh* settled intraday (1D) bar can be pulled right now. Inside
 * the warm-up window there is no settled intraday bar worth pulling yet (mirrors
 * `freshness.ts` MARKET_WARMUP_MS), so only the steady-open phase qualifies. */
function intradayLiveNow(market: MarketCondition): boolean {
  return market === "open-steady";
}

/**
 * Whether the EUR/USD forex market is open. Forex trades ~24×5 — through US
 * equity holidays — and only fully shuts over the weekend.
 */
function forexOpen(market: MarketCondition): boolean {
  return market !== "weekend";
}

/** Whether the device carries any prior on-device cache. */
function hasCache(freshness: DeviceFreshness): boolean {
  return freshness !== "empty-device" && freshness !== "first-login-currency-unknown";
}

/**
 * The core completeness check. Pure: given a world-state, it enumerates the
 * load paths for every core value and asserts at least one exists.
 *
 * The guarantee it encodes: **once holdings are known** (a blob is present, or a
 * prior cache survives), every core value is reachable — prices/FX from the
 * orchestrator or blob or cache, 1D/1W from the blob or a stored-bar
 * reconstruction or a live leg, and the long-range history from a from-scratch
 * daily-bar reconstruction that never depends on day-by-day recording. With no
 * holdings at all the verdict is `awaitingBlob`, honestly reflecting that the
 * blob must be decrypted first.
 */
export function checkDataCoverage(inputs: CoverageInputs): CoverageVerdict {
  const { market, freshness, blob } = inputs;
  const blobPresent = blob !== "absent";
  const cache = hasCache(freshness);
  // Only the blob establishes which holdings exist; a prior cache also implies
  // we already know them. Without either, there is nothing to load yet.
  const hasHoldings = blobPresent || cache;

  const coverage: CoreCoverage[] = CORE_VALUES.map((value) => {
    const sources: LoadSource[] = [];

    switch (value) {
      case "prices":
        // Live quotes for known holdings, the blob's settled prices, or cache.
        if (blobPresent) sources.push("blob");
        if (cache) sources.push("cache");
        if (hasHoldings) sources.push("orchestrator");
        break;

      case "fx":
        // Live EUR/USD only while forex is open; otherwise the blob's settled
        // rate or the last cached spot keep the currency split honest.
        if (blobPresent) sources.push("blob");
        if (cache) sources.push("cache");
        if (hasHoldings && forexOpen(market)) sources.push("orchestrator");
        break;

      case "oneDay":
        // The blob springboard session, a fresh intraday leg, or a rebuild from
        // the stored 1D bars.
        if (blobPresent) sources.push("blob");
        if (hasHoldings && intradayLiveNow(market)) sources.push("orchestrator");
        if (cache) sources.push("reconstruction");
        break;

      case "oneWeek":
        // The blob sleeve, a weekBars leg on a trading day, or a rebuild from
        // the stored daily-close bars.
        if (blobPresent) sources.push("blob");
        if (hasHoldings && isEquityTradingDay(market)) sources.push("orchestrator");
        if (cache) sources.push("reconstruction");
        break;

      case "longRange":
        // The blob's analytics curve, the recorded value-history store, or the
        // from-scratch multi-month daily-bar reconstruction — which is always
        // available once holdings are known, on any calendar day.
        if (blobPresent) sources.push("blob");
        if (cache) sources.push("cache");
        if (hasHoldings) sources.push("reconstruction");
        break;
    }

    return { value, sources, covered: sources.length > 0 };
  });

  const missing = coverage.filter((c) => !c.covered).map((c) => c.value);
  const awaitingBlob = !hasHoldings;
  // When awaiting the blob there are no holdings, so "missing" everything is the
  // expected, honest state — not a defect.
  const ok = awaitingBlob || missing.length === 0;

  return { ok, coverage, missing, awaitingBlob };
}

/**
 * A single-line, human-readable verdict for the polling log. Keeps the
 * orchestrator's "readable brain" principle: a complete brain says so, and a
 * gap names exactly which core value lost its last path.
 */
export function summarizeCoverage(inputs: CoverageInputs, verdict: CoverageVerdict): string {
  const where = `${inputs.market}/${inputs.freshness}/blob:${inputs.blob}`;
  if (verdict.awaitingBlob) {
    return `Coverage: awaiting blob — no holdings yet (${where}). Decrypt the export first.`;
  }
  if (verdict.ok) {
    return `Coverage: complete — every core value has a load path (${where}).`;
  }
  return `Coverage: GAP — no load path for ${verdict.missing.join(", ")} (${where}).`;
}

/** The severity to log a verdict at, so a genuine gap stands out. */
export function coverageLogLevel(verdict: CoverageVerdict): "good" | "info" | "warn" {
  if (verdict.awaitingBlob) return "info";
  return verdict.ok ? "good" : "warn";
}

/**
 * The flags the live clock + device state expose, mapped to a coarse
 * {@link MarketCondition}. Pure, so the mapping is testable without a clock.
 */
export interface MarketConditionFlags {
  /** A weekday the US market trades (not a weekend, not a holiday). */
  isEquityTradingDay: boolean;
  /** Saturday or Sunday. */
  isWeekend: boolean;
  /** A recognised US market holiday (weekday, equities shut). */
  isHoliday: boolean;
  /** The regular US session is open right now. */
  isMarketOpen: boolean;
  /** Open, but for less than the warm-up window (no settled intraday bar yet). */
  isWarmingUp: boolean;
  /** After today's close, before the NAV funds have published. */
  isAfterCloseNavPending: boolean;
  /** A trading day, before the opening bell (distinguishes pre-open from overnight). */
  isBeforeOpen: boolean;
}

/**
 * Collapse the live flags into the single {@link MarketCondition} the
 * self-check reasons over. Order matters: weekend/holiday win, then open
 * sub-states, then the after-close / overnight / pre-open splits.
 */
export function marketConditionFrom(flags: MarketConditionFlags): MarketCondition {
  if (flags.isWeekend) return "weekend";
  if (flags.isHoliday) return "holiday";
  if (flags.isMarketOpen) return flags.isWarmingUp ? "open-lt-30m" : "open-steady";
  if (flags.isAfterCloseNavPending) return "after-close-nav-pending";
  if (flags.isBeforeOpen) return "pre-open";
  if (flags.isEquityTradingDay) return "overnight";
  return "pre-open";
}
