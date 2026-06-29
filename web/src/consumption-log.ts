/**
 * A persistent, human-readable **data-loading (consumption) log** for the main
 * overview page — the *read* counterpart to the polling log.
 *
 * The polling log (`polling-log.ts`) answers "what data did we *fetch* from the
 * web?". But the graphs, holdings and currency KPIs no longer request data — they
 * simply *read* whatever the live layer already left in the model. There are many
 * consumers in many places reading many different fields, so the question this
 * module answers is the mirror image: "given what was available, what did the
 * overview's views actually *consume*, and where did they have to fall back to
 * **alternative data because the perfect data was missing**?".
 *
 * Rather than emit a line per consumer (there are far too many), it takes the
 * already-built {@link DashboardModel} — the single source the whole overview
 * reads from — and distils one **summarised snapshot** across the three consumer
 * families the user cares about: `holdings`, `graph` and `currency` KPIs. Each
 * family carries a one-line headline plus a small set of **flags** that call out
 * the weird / interesting / uncommon moments (a holding dropped from totals, a
 * KPI that fell back to its EUR figure, a chart tip that couldn't be drawn, the
 * data-file gap a device backfill had to bridge). A per-snapshot
 * "needed to be perfect" line names exactly what was missing.
 *
 * To stay summarised it **de-duplicates** consecutive snapshots that share the
 * same set of flags: an unchanging "all good" state collapses to a single row
 * (with a repeat count + last-seen stamp), and a *new* row only appears the
 * moment the consumed picture actually changes — i.e. exactly the moments worth
 * looking at. Like the polling log it is best-effort and dependency-free: it keeps
 * a small in-memory tail so it is still downloadable in private mode and never
 * throws into a render.
 */

import type { StorageLike } from "./cache";
import type { DashboardModel, HoldingView, OverviewView } from "./compute";
import { isForexMarketOpen, forexMarketReopenMs } from "./market-hours";
import { formatForexReopen } from "./format";

const LOG_KEY = "iv.web.consumption_log";

/** Cap the persisted log so it can never grow unbounded in localStorage. */
export const MAX_CONSUMPTION_SNAPSHOTS = 300;

/** Size of the in-memory tail kept independently of storage, so the log stays
 * downloadable in private mode (where localStorage writes are dropped). Small —
 * it only needs to cover the current session's most recent states. */
const MEMORY_TAIL_SIZE = 32;

/** The three consumer families on the main overview page we track reads for. */
export type ConsumptionDomain = "holdings" | "graph" | "currency";

/**
 * Severity of a single flagged consumption moment.
 * - `info`  — a benign substitution worth knowing about (a settled close, a
 *             device backfill bridging a stale data file).
 * - `warn`  — a view had to read **alternative data** because the ideal data was
 *             missing (a holding fell back to its last exported value, a USD KPI
 *             fell back to EUR, EUR/USD was only the coarse end-of-day rate).
 * - `error` — a view could not be served at all (a holding dropped from totals,
 *             no EUR/USD so USD figures are impossible, the chart tip can't draw).
 */
export type ConsumptionLevel = "info" | "warn" | "error";

/** One flagged moment within a domain — what was needed, what was substituted. */
export interface ConsumptionFlag {
  level: ConsumptionLevel;
  message: string;
}

/** The consumed picture for one domain in a single read. */
export interface DomainConsumption {
  /** A short, plain-language headline of what this family read this round. */
  summary: string;
  /** True when the views got exactly the data they wanted (no substitution). */
  perfect: boolean;
  /** The weird / interesting / uncommon moments in this read (may be empty). */
  flags: ConsumptionFlag[];
}

/** The distilled consumption picture for a single overview render. */
export interface ConsumptionSummary {
  holdings: DomainConsumption;
  graph: DomainConsumption;
  currency: DomainConsumption;
  /** True only when all three families read perfect data. */
  perfect: boolean;
  /**
   * The concrete things this read needed to be perfect (e.g. "live prices for
   * AAPL, MSFT", "an EUR/USD spot rate", "a fresh data file"). Empty when perfect.
   */
  needed: string[];
  /**
   * A stable fingerprint of the *flagged* state (not the live counts), used to
   * collapse consecutive identical states into one row so the log stays
   * summarised and a new row marks a genuine change in the consumed picture.
   */
  signature: string;
}

/** One persisted snapshot: a distilled read plus when/how-often it was seen. */
export interface ConsumptionSnapshot extends ConsumptionSummary {
  /** Epoch ms this state was first observed. */
  at: number;
  /** Epoch ms this state was most recently observed. */
  lastAt: number;
  /** How many consecutive overview renders shared this exact state. */
  count: number;
}

/** Options for {@link appendConsumptionSnapshot}. */
export interface AppendConsumptionOptions {
  /** Epoch ms to stamp the entry with (defaults to now). */
  at?: number;
  /** Storage to persist into (defaults to localStorage). */
  storage?: StorageLike | null;
  /**
   * Force a brand-new snapshot row even when the signature matches the last one,
   * so the full reconciliation detail is re-emitted verbatim instead of folding
   * into a repeat count. Set by a hard Settings "Regenerate 1D/1W graph": the
   * owner explicitly asked to see the merge spelled out, not collapsed.
   */
  forceNewRow?: boolean;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Cap a symbol/label list so a flag line stays short, e.g. `A, B, C +4 more`. */
function joinCapped(items: string[], cap = 8): string {
  if (items.length <= cap) return items.join(", ");
  return `${items.slice(0, cap).join(", ")} +${items.length - cap} more`;
}

// ---------------------------------------------------------------------------
// Summarising a model into a consumption picture (pure, fully testable).
// ---------------------------------------------------------------------------

/**
 * The market-clock context a read happened in. The spot-FX market is shut all
 * weekend (Fri 17:00 ET → Sun 17:00 ET), so over that window a *live* EUR/USD
 * spot simply cannot exist — the keyless end-of-day rate is the best obtainable
 * data, not a degradation. The summariser uses this to reframe the weekend FX
 * fallback as expected (an `info` note that says plainly *why* it is impossible)
 * rather than flagging it as missing-perfect data and asking for the impossible.
 */
interface FxMarketContext {
  /** True when the spot-FX market is shut (the weekend), so no live spot exists. */
  fxClosed: boolean;
  /** A reader-local "reopens …" caption for the weekend close (empty when open). */
  reopen: string;
}

function fxMarketContext(now: Date): FxMarketContext {
  const fxClosed = !isForexMarketOpen(now);
  return {
    fxClosed,
    reopen: fxClosed ? formatForexReopen(forexMarketReopenMs(now), now) : "",
  };
}

/** What the holdings cards/totals read, and where they fell back. */
function summariseHoldings(model: DashboardModel, needed: string[]): DomainConsumption {
  const o = model.overview;
  const holdings: HoldingView[] = model.holdings;
  const missing = new Set(o.missingPriceSymbols);
  const stale = new Set(o.staleValueSymbols);

  let live = 0;
  let settled = 0;
  const missingSyms: string[] = [];
  const staleSyms: string[] = [];
  const moveStaleSyms: string[] = [];
  for (const h of holdings) {
    if (missing.has(h.symbol)) {
      missingSyms.push(h.symbol);
      continue;
    }
    if (stale.has(h.symbol)) {
      staleSyms.push(h.symbol);
      continue;
    }
    if (h.priceIsLive) live += 1;
    else settled += 1;
    if (h.todayMoveIsStale) moveStaleSyms.push(h.symbol);
  }

  const flags: ConsumptionFlag[] = [];
  if (missingSyms.length > 0) {
    flags.push({
      level: "error",
      message: `${missingSyms.length} holding(s) had no price at all (no live quote, no last-known price, no exported value) and were dropped from the totals: ${joinCapped(missingSyms)}.`,
    });
    needed.push(`a price for ${joinCapped(missingSyms, 4)}`);
  }
  if (staleSyms.length > 0) {
    flags.push({
      level: "warn",
      message: `${staleSyms.length} holding(s) could not be priced live (no quote/FX leg) and fell back to their last exported value — still counted, but stale: ${joinCapped(staleSyms)}.`,
    });
    needed.push(`a live price for ${joinCapped(staleSyms, 4)}`);
  }
  if (moveStaleSyms.length > 0 && moveStaleSyms.length < holdings.length) {
    flags.push({
      level: "info",
      message: `${moveStaleSyms.length} holding(s) are still on an earlier session's price, so their day move is last session's, not today's: ${joinCapped(moveStaleSyms)}.`,
    });
  }

  const total = holdings.length;
  const parts: string[] = [];
  if (live > 0) parts.push(`${live} live`);
  if (settled > 0) parts.push(`${settled} on a settled close`);
  if (staleSyms.length > 0) parts.push(`${staleSyms.length} stale fallback`);
  if (missingSyms.length > 0) parts.push(`${missingSyms.length} unpriced`);
  const summary = `${total} holding(s): ${parts.length ? parts.join(", ") : "none priced"}.`;
  const perfect = missingSyms.length === 0 && staleSyms.length === 0;
  return { summary, perfect, flags };
}

/** Names of the USD KPI companions that are currently unavailable. */
function missingUsdKpis(o: OverviewView): string[] {
  const checks: Array<[string, unknown]> = [
    ["total value", o.totalValueUsd],
    ["total gain %", o.totalGainPctUsd],
    ["today's move %", o.todayMovePctUsd],
    ["month-to-date %", o.mtdGrowthPctUsd],
    ["year-to-date %", o.ytdGrowthPctUsd],
    ["XIRR", o.portfolioXirrUsd],
    ["total growth %", o.totalGrowthCompoundedPctUsd],
  ];
  return checks.filter(([, v]) => v === null).map(([label]) => label);
}

/** What the currency KPIs read for FX, and where the USD/EUR figures fell back. */
function summariseCurrency(model: DashboardModel, needed: string[], fx: FxMarketContext): DomainConsumption {
  const o = model.overview;
  const flags: ConsumptionFlag[] = [];

  const SOURCE_LABEL: Record<OverviewView["eurUsdSource"], string> = {
    live: "live spot",
    cache: "a cached spot",
    tiingo: "the backup provider (Tiingo)",
    eod: "the keyless end-of-day rate",
    none: "no rate",
  };
  const sourceLabel = SOURCE_LABEL[o.eurUsdSource] ?? String(o.eurUsdSource);

  // Over the weekend the spot-FX market is shut, so a live EUR/USD cannot exist:
  // reading the keyless end-of-day rate is then the best obtainable data, not a
  // fault. Note it (still flagged so the reader knows the rate is frozen) but at
  // `info`, with an explicit passage of *why* it is impossible, and do not ask for
  // a live spot we could never get until the market reopens.
  const eodFrozenForWeekend = o.eurUsdSource === "eod" && fx.fxClosed;

  if (o.eurUsdSource === "none") {
    flags.push({
      level: "error",
      message: "No EUR/USD rate was available, so USD figures could not be derived and USD-native holdings could not be converted to EUR.",
    });
    needed.push("an EUR/USD spot rate");
  } else if (eodFrozenForWeekend) {
    flags.push({
      level: "info",
      message: `EUR/USD is the last keyless end-of-day rate, held frozen because the spot-FX market is shut for the weekend (${fx.reopen}) — no live intraday rate can exist until it reopens, so currency KPIs and the graph's EUR/USD split correctly carry this settled weekend rate rather than waiting for a live spot.`,
    });
  } else if (o.eurUsdSource === "eod") {
    flags.push({
      level: "warn",
      message: "EUR/USD was only the keyless end-of-day rate (no intraday timestamp), so currency KPIs and the graph's EUR/USD split read a coarse daily rate instead of a live spot.",
    });
    needed.push("a live EUR/USD spot rate");
  } else if (o.eurUsdSource === "tiingo") {
    flags.push({
      level: "warn",
      message: "EUR/USD came from the backup provider (Tiingo), not the primary live spot.",
    });
  }

  if (o.fxMissingCurrencies.length > 0) {
    flags.push({
      level: "warn",
      message: `No FX leg for ${joinCapped(o.fxMissingCurrencies)}, so EUR values for holdings in those currencies could not be computed.`,
    });
    needed.push(`an FX rate for ${joinCapped(o.fxMissingCurrencies, 4)}`);
  }

  const usdGaps = o.eurUsdSource === "none" ? [] : missingUsdKpis(o);
  if (usdGaps.length > 0) {
    flags.push({
      level: "warn",
      message: `The USD companion was missing for ${joinCapped(usdGaps)}, so switching to USD shows the EUR figure for these instead.`,
    });
  }

  // EUR-side KPIs that simply could not be computed from the available inputs —
  // the view then renders a "–". These are missing *inputs*, not FX gaps.
  const eurGaps: string[] = [];
  if (o.totalGainPct === null) eurGaps.push("total gain %");
  if (o.portfolioXirr === null) eurGaps.push("XIRR");
  if (o.mtdGrowthPct === null) eurGaps.push("month-to-date %");
  if (o.ytdGrowthPct === null) eurGaps.push("year-to-date %");
  if (eurGaps.length > 0) {
    flags.push({
      level: "info",
      message: `These KPIs had no value to read (missing cost basis or period baseline) and show as "–": ${joinCapped(eurGaps)}.`,
    });
  }

  const summary = `EUR/USD read from ${sourceLabel}${
    eodFrozenForWeekend ? " (frozen for the weekend)" : ""
  }; ${
    usdGaps.length === 0 && o.eurUsdSource !== "none" ? "USD companions complete" : `${usdGaps.length} USD KPI(s) on the EUR fallback`
  }.`;
  // The weekend end-of-day rate is the best obtainable FX (a live spot cannot
  // exist while the market is shut), so — like a holding on a settled close — it
  // counts as a perfect read rather than blocking on the impossible.
  const fxAcceptable = o.eurUsdSource === "live" || o.eurUsdSource === "cache" || eodFrozenForWeekend;
  const perfect =
    fxAcceptable &&
    o.fxMissingCurrencies.length === 0 &&
    usdGaps.length === 0;
  return { summary, perfect, flags };
}

/**
 * What the overview value chart could read, and where it bridged/stopped. Also
 * reports the two inputs unique to the live 1D/1W curves — the **NAV sleeve** the
 * 1W graph re-marks from daily-NAV bars, and the **EUR/USD freeze anchor** the
 * 1D/1W EUR line is drawn from — so a data gap on those short windows is surfaced
 * explicitly rather than hidden behind the long-history chart's summary.
 */
function summariseGraph(model: DashboardModel, needed: string[], fx: FxMarketContext): DomainConsumption {
  const o = model.overview;
  const flags: ConsumptionFlag[] = [];

  const tipDrawable = o.totalValueIsComplete && o.totalValueUsd !== null;
  const backfillDays = model.valueBackfill?.length ?? 0;
  const staleCount = o.staleValueSymbols.length;

  if (!tipDrawable) {
    flags.push({
      level: "warn",
      message: "The book was incomplete (a holding had no price, FX or fallback), so the chart could not draw today's live tip — it reads only up to the last exported close.",
    });
    needed.push("a complete book to draw today's chart tip");
  }
  if (o.liveDegradedReason) {
    flags.push({
      level: "warn",
      message: `Live data was degraded (${o.liveDegradedReason}); the chart's latest point is a carried-over value, not a fresh mark.`,
    });
  }
  if (backfillDays > 0) {
    flags.push({
      level: "info",
      message: `${backfillDays} day(s) of whole-book closes were rebuilt from device history to bridge the gap a stale data file left before today.`,
    });
    needed.push("an up-to-date data file (recent closes were rebuilt on-device)");
  }
  if (tipDrawable && staleCount > 0) {
    flags.push({
      level: "info",
      message: `Today's chart tip total includes ${staleCount} holding(s) carried at their last exported value.`,
    });
  }

  // The live 1D/1W graphs read two extra inputs the long-history value chart does
  // not — the **NAV sleeve** (1W) and the **EUR/USD freeze anchor** (1D + 1W) —
  // so report explicitly what each had available, since a gap there is felt only
  // on those short-window curves and is easy to miss otherwise.
  const navIssue = summariseGraphNav(model, flags, needed);
  const fxIssue = summariseGraphFx(model, flags, needed, fx);

  let summary: string;
  if (tipDrawable) {
    summary = backfillDays > 0
      ? `Value chart: complete book today, ${backfillDays} day(s) bridged from device history.`
      : "Value chart: complete book, today's live tip drawable.";
  } else {
    summary = "Value chart: incomplete book — no live tip, chart stops at the last export.";
  }
  const perfect =
    tipDrawable && backfillDays === 0 && !o.liveDegradedReason && staleCount === 0 && !navIssue && !fxIssue;
  return { summary, perfect, flags };
}

/**
 * Whether a NAV fund carries the inputs the 1W graph needs to re-mark it from its
 * daily-NAV bars (a real price, a positive share count, a price symbol and both
 * currency legs). A fund failing this is pinned flat in the week's base instead,
 * so its NAV drift never reaches the curve — mirrors `buildIntradayAnchor`'s
 * `pricedLot && priceType === "nav"` sleeve test. Returns true when the fund can
 * be re-marked from its daily-NAV bars.
 */
function isNavRemarkable(h: HoldingView): boolean {
  return (
    h.priceNative !== null &&
    !h.priceNative.isZero() &&
    h.valueEur !== null &&
    h.valueUsd !== null &&
    (h.priceSymbol ?? "").length > 0
  );
}

/**
 * Report the **NAV portion of the 1W graph**: which NAV funds re-marked from their
 * daily-NAV bars versus which had to be pinned flat (so the week shows no NAV
 * drift for them). Returns true when a fund was pinned flat — a genuine gap that
 * keeps the graph read from being perfect. The 1D graph leaves NAV funds flat by
 * design (NAV strikes once a day), so this is a 1W-only concern.
 */
function summariseGraphNav(model: DashboardModel, flags: ConsumptionFlag[], needed: string[]): boolean {
  const navFunds = model.holdings.filter((h) => h.priceType === "nav");
  if (navFunds.length === 0) return false;

  const flatNav = navFunds.filter((h) => !isNavRemarkable(h));
  const staleNav = navFunds.filter((h) => isNavRemarkable(h) && h.valueIsStale);

  if (flatNav.length > 0) {
    flags.push({
      level: "warn",
      message: `1W graph NAV sleeve: ${flatNav.length} of ${navFunds.length} NAV fund(s) had no usable price/share count, so the week re-mark pinned them flat in the base and drew no NAV drift for them: ${joinCapped(flatNav.map((h) => h.symbol))}.`,
    });
    needed.push(`a NAV price for the 1W graph (${joinCapped(flatNav.map((h) => h.symbol), 4)})`);
  } else {
    flags.push({
      level: "info",
      message: `1W graph NAV sleeve: all ${navFunds.length} NAV fund(s) re-marked from their daily-NAV bars.`,
    });
  }
  if (staleNav.length > 0) {
    flags.push({
      level: "info",
      message: `1W graph NAV sleeve: ${staleNav.length} NAV fund(s) carry a stale (last-exported) value, so their week tip is carried, not freshly struck: ${joinCapped(staleNav.map((h) => h.symbol))}.`,
    });
  }
  return flatNav.length > 0;
}

/**
 * Report the **FX portion of the 1D/1W graphs**: what EUR/USD the EUR line is
 * drawn from (the USD line is FX-free, since USD is the booked currency), and
 * whether a settled session-close rate exists to freeze the EUR view to once the
 * market shuts. Returns true when the EUR line could not be drawn at all (no rate)
 * or read a coarse end-of-day rate — the gaps the user suspects on these curves.
 * Skipped for a EUR-only book, where the graphs need no FX.
 */
function summariseGraphFx(model: DashboardModel, flags: ConsumptionFlag[], needed: string[], fx: FxMarketContext): boolean {
  const o = model.overview;
  const hasNonEur = model.holdings.some((h) => (h.nativeCurrency ?? "EUR").toUpperCase() !== "EUR");
  if (!hasNonEur) return false;

  if (o.eurUsdSource === "none" || o.fxRateEurUsd === null) {
    flags.push({
      level: "error",
      message: "1D/1W graph FX: no EUR/USD rate, so the graphs' EUR line cannot be drawn (the FX-free USD line still draws).",
    });
    needed.push("an EUR/USD rate for the 1D/1W graph EUR line");
    return true;
  }

  // A settled session-close rate is what the graphs freeze the EUR view to once
  // the market is shut; without it the EUR line falls back (live capture → prior
  // close → live rate) and can slide with overnight FX. Null while the session is
  // still open is normal, so this is a note, not a fault.
  if (o.fxRateEurUsdSessionClose === null) {
    flags.push({
      level: "info",
      message: "1D/1W graph FX: no settled session-close EUR/USD captured, so once the market shuts the graphs' EUR view falls back (live capture → prior close → live rate) rather than freezing to the authoritative close.",
    });
  }

  if (o.eurUsdSource === "eod") {
    // Over the weekend the spot-FX market is shut, so the EUR line *cannot* read a
    // live intraday rate: holding the last end-of-day rate is correct, not coarse.
    // Note it as expected (info) rather than flagging an approximate shape.
    if (fx.fxClosed) {
      flags.push({
        level: "info",
        message: `1D/1W graph FX: the EUR line holds the last keyless end-of-day EUR/USD because the spot-FX market is shut for the weekend (${fx.reopen}) — no intraday rate can exist until it reopens, so the EUR line stays flat at this settled rate by design rather than being approximated.`,
      });
      return false;
    }
    flags.push({
      level: "warn",
      message: "1D/1W graph FX: the EUR line reads the coarse keyless end-of-day rate (no intraday timestamp), so its market-day shape is approximate.",
    });
    return true;
  }
  if (o.eurUsdSource === "tiingo") {
    flags.push({
      level: "info",
      message: "1D/1W graph FX: the EUR line reads the backup provider's rate (Tiingo), not the primary live spot.",
    });
    return false;
  }
  flags.push({
    level: "info",
    message: `1D/1W graph FX: the EUR line is anchored to the ${o.eurUsdSource === "cache" ? "cached" : "live"} EUR/USD spot.`,
  });
  return false;
}

/**
 * Distil a built {@link DashboardModel} into a single, summarised consumption
 * picture across holdings, the value graph and the currency KPIs. Pure: takes no
 * storage and has no side effects, so it is fully unit-testable. `now` (the read
 * instant) lets the summariser tell whether the spot-FX market is open: over the
 * weekend a live EUR/USD cannot exist, so the end-of-day rate is reframed as the
 * expected best-obtainable data instead of a missing-perfect fault.
 */
export function summariseConsumption(model: DashboardModel, now: Date = new Date()): ConsumptionSummary {
  const needed: string[] = [];
  const fx = fxMarketContext(now);
  const holdings = summariseHoldings(model, needed);
  // Currency before graph so a missing FX rate is the first "needed" item.
  const currency = summariseCurrency(model, needed, fx);
  const graph = summariseGraph(model, needed, fx);
  // Fold any queued data-fixing/reconciliation notes into the graph domain so
  // every repair shows up in the data-loading log (not the polling log). They
  // drain once: a recurring fix re-queues next round, but the snapshot signature
  // collapses identical states, so it is detailed once and then folds to a count.
  if (pendingReconcile.length > 0) {
    graph.flags.push(...pendingReconcile);
    if (pendingReconcile.some((f) => f.level !== "info")) graph.perfect = false;
    pendingReconcile = [];
  }
  const perfect = holdings.perfect && currency.perfect && graph.perfect;
  // De-dupe the "needed" list while preserving order.
  const neededUnique = [...new Set(needed)];
  const signature = JSON.stringify([
    holdings.flags.map((f) => `${f.level}:${f.message}`),
    currency.flags.map((f) => `${f.level}:${f.message}`),
    graph.flags.map((f) => `${f.level}:${f.message}`),
  ]);
  return { holdings, graph, currency, perfect, needed: neededUnique, signature };
}

// ---------------------------------------------------------------------------
// Persistence (best-effort, de-duplicating).
// ---------------------------------------------------------------------------

let memoryTail: ConsumptionSnapshot[] = [];

/**
 * Pending **data-fixing / reconciliation** notes to fold into the next snapshot's
 * graph domain. The repairs (NAV-collapse heal, currency-divergence rebuild, the
 * 1W web⇄blob merge) happen in the build/render path, not derivable from the
 * model — so they queue here and are drained into the graph flags by
 * {@link summariseConsumption}. De-duplicated downstream by the snapshot
 * signature, giving the detailed-first / collapse-on-repeat policy for free.
 */
let pendingReconcile: ConsumptionFlag[] = [];

/**
 * Queue a reconciliation/fixing note for the data-loading log. Best-effort and
 * de-duplicated: the same message queued twice before a snapshot is kept once.
 */
export function recordReconciliation(message: string, level: ConsumptionLevel = "warn"): void {
  if (pendingReconcile.some((f) => f.message === message)) return;
  pendingReconcile.push({ level, message });
}

function isSnapshot(value: unknown): value is ConsumptionSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as ConsumptionSnapshot;
  return (
    typeof s.at === "number" &&
    typeof s.lastAt === "number" &&
    typeof s.count === "number" &&
    typeof s.signature === "string" &&
    !!s.holdings &&
    !!s.graph &&
    !!s.currency
  );
}

function readRaw(storage: StorageLike | null): ConsumptionSnapshot[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSnapshot);
  } catch {
    return [];
  }
}

function pickFreshest(persisted: ConsumptionSnapshot[]): ConsumptionSnapshot[] {
  return persisted.length >= memoryTail.length ? persisted : memoryTail;
}

/**
 * Record a consumption snapshot for the current overview render. Consecutive
 * renders that share the same {@link ConsumptionSummary.signature} (the same set
 * of flags) are **merged** into the last row — its `lastAt`/`count` advance and
 * its headline summaries refresh to the latest figures — so an unchanging state
 * never floods the log and a *new* row marks a genuine change. Never throws.
 */
export function appendConsumptionSnapshot(summary: ConsumptionSummary, opts: AppendConsumptionOptions = {}): void {
  const now = opts.at ?? Date.now();
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const existing = pickFreshest(readRaw(storage));
  let next: ConsumptionSnapshot[];
  const last = existing[existing.length - 1];
  if (last && last.signature === summary.signature && !opts.forceNewRow) {
    // Same flagged state: merge in place, refreshing the headline figures and the
    // last-seen stamp, and bumping the repeat count.
    const merged: ConsumptionSnapshot = {
      ...summary,
      at: last.at,
      lastAt: now,
      count: last.count + 1,
    };
    next = [...existing.slice(0, -1), merged];
  } else {
    const entry: ConsumptionSnapshot = { ...summary, at: now, lastAt: now, count: 1 };
    next = [...existing, entry].slice(-MAX_CONSUMPTION_SNAPSHOTS);
  }
  memoryTail = next.slice(-Math.min(next.length, MEMORY_TAIL_SIZE));
  if (!storage) return;
  try {
    storage.setItem(LOG_KEY, JSON.stringify(next));
  } catch {
    /* storage full/unavailable — the in-memory tail still covers this session. */
  }
}

/** Convenience: summarise a model and append it in one call. */
export function recordConsumption(model: DashboardModel, opts: AppendConsumptionOptions = {}): void {
  const now = opts.at !== undefined ? new Date(opts.at) : new Date();
  appendConsumptionSnapshot(summariseConsumption(model, now), opts);
}

/** Read the full persisted consumption log (oldest first), falling back to memory. */
export function readConsumptionLog(storage: StorageLike | null = defaultStorage()): ConsumptionSnapshot[] {
  return pickFreshest(readRaw(storage));
}

/** Clear the persisted consumption log (and the in-memory tail). */
export function clearConsumptionLog(storage: StorageLike | null = defaultStorage()): void {
  memoryTail = [];
  pendingReconcile = [];
  if (!storage) return;
  try {
    storage.removeItem(LOG_KEY);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Rendering a downloadable report.
// ---------------------------------------------------------------------------

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => `${n}`.padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => `${n}`.padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LEVEL_GLYPH: Record<ConsumptionLevel, string> = {
  info: "·",
  warn: "⚠",
  error: "✗",
};

const DOMAIN_LABEL: Record<ConsumptionDomain, string> = {
  holdings: "HOLDINGS",
  graph: "GRAPH",
  currency: "CURRENCY",
};

function renderDomain(domain: ConsumptionDomain, d: DomainConsumption): string[] {
  const lines: string[] = [];
  const mark = d.perfect ? "✓" : "⚠";
  lines.push(`┃   ${mark} [${DOMAIN_LABEL[domain].padEnd(8)}] ${d.summary}`);
  for (const f of d.flags) {
    lines.push(`┃       ${LEVEL_GLYPH[f.level]} ${f.message}`);
  }
  return lines;
}

function renderSnapshot(snap: ConsumptionSnapshot, index: number): string {
  const lines: string[] = [];
  const span =
    snap.at === snap.lastAt
      ? clock(snap.at)
      : `${clock(snap.at)} → ${clock(snap.lastAt)}`;
  const repeat = snap.count > 1 ? ` · seen ${snap.count}×` : "";
  const verdict = snap.perfect ? "PERFECT — views read exactly what they needed" : "DEGRADED — some views read alternative data";
  const dateLabel = stamp(snap.at).slice(0, 10);
  lines.push("");
  lines.push(`┏━━ READ ${index} · ${verdict}`);
  lines.push(`┃   ${dateLabel} · ${span}${repeat}`);
  lines.push(...renderDomain("holdings", snap.holdings));
  lines.push(...renderDomain("graph", snap.graph));
  lines.push(...renderDomain("currency", snap.currency));
  if (snap.needed.length > 0) {
    lines.push(`┗━━ Needed to be perfect: ${snap.needed.join("; ")}.`);
  } else {
    lines.push("┗━━ ✓ Nothing missing — every view had ideal data.");
  }
  return lines.join("\n");
}

/**
 * Render the consumption log as a downloadable plain-text report. Each block is
 * one distinct **read state** of the overview (de-duplicated runs of identical
 * states are collapsed with a repeat count), summarised across holdings, the
 * value graph and the currency KPIs, with the weird/uncommon moments flagged and
 * a "needed to be perfect" verdict. A macro header counts the states and how many
 * were degraded, so a glance answers "did the views ever miss data, and where?".
 */
export function formatConsumptionLog(
  snapshots: ConsumptionSnapshot[] = readConsumptionLog(),
  meta: { version?: string; generatedAt?: number } = {},
): string {
  const generatedAt = meta.generatedAt ?? Date.now();
  const degraded = snapshots.filter((s) => !s.perfect).length;
  const header = [
    "Investment Overview — data loading (consumption) log",
    meta.version ? `App version: ${meta.version}` : null,
    `Generated: ${stamp(generatedAt)}`,
    `Distinct read states: ${snapshots.length}  ·  Degraded states: ${degraded}`,
    "This log shows what the main overview's holdings, graph and currency KPIs",
    "actually read from the available data — and where they fell back to",
    "alternative data because the perfect data was missing.",
    "Times are local to this device. Newest states are at the bottom.",
    "",
    "Legend:  ✓ perfect/complete   · note   ⚠ read alternative data   ✗ data unavailable",
    "Each state is bounded by ┏━━ (start) and ┗━━ (what it needed to be perfect).",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  if (snapshots.length === 0) {
    return `${header}\n\n(no overview reads recorded yet)\n`;
  }
  const body = snapshots.map((snap, i) => renderSnapshot(snap, i + 1)).join("\n");
  return `${header}\n${body}\n`;
}
