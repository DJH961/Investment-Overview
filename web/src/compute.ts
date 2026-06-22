/**
 * Live computation layer: combine the decrypted export with live quotes + FX
 * into the Overview KPIs and per-holding rows the UI renders.
 *
 * Phase 3 scope (proposal §9): the live "how am I doing right now" view —
 * total value, today's move, total gain, and XIRR (portfolio and per holding),
 * all carried in EUR as the internal FX-pivot — a common denominator for
 * conversion, not a base/primary currency (USD is the native booked currency
 * for almost every transaction; see currency.ts) — and converted to the chosen
 * display currency at render time. Completed-period and analytics *display* is
 * Phase 4; those blocks ride along in the export but are not surfaced here yet.
 *
 * All money maths uses decimal.js; the ported `returns` functions provide XIRR.
 */

import { Decimal } from "./decimal-config";
import { convert, type FxRates, type Quote } from "./prices";
import { xirr, totalGrowthPctCompounded, yearsBetween, type Cashflow } from "./returns";
import {
  buildAnalytics,
  buildDeposits,
  buildPeriods,
  buildPlan,
  type AnalyticsView,
  type DepositsView,
  type PeriodsView,
  type PlanView,
} from "./phase4";
import type { ExportCashflow, ExportHolding, MobileExport } from "./types";
import { isMoneyMarketHolding } from "./money-market";

const EUR = "EUR";
const USD = "USD";

/**
 * Twelve Data free-tier daily credit cap, mirrored here so the pure compute
 * layer can default {@link OverviewView.dailyCreditLimit} without importing the
 * network/quotes module. Keep in step with `quotes.ts` `FREE_TIER.creditsPerDay`.
 */
const FREE_TIER_CREDITS_PER_DAY = 800;

export interface HoldingView {
  symbol: string;
  name: string;
  assetClass: string;
  broker: string;
  account: string;
  nativeCurrency: string;
  priceType: "market" | "nav";
  shares: Decimal;
  priceNative: Decimal | null;
  /** True when a fresh live quote supplied the price (vs. exported fallback). */
  priceIsLive: boolean;
  /**
  /**
   * Epoch ms the displayed price was observed (live fetch or cache hit), or
   * null when it came from the export's last-known value. Drives the per-row
   * "as of" freshness indicator.
   */
  priceAsOf: number | null;
  /** Date the displayed price applies to when `priceAsOf` is null — a NAV's
   * value-date, or the export's valuation date (`meta.as_of`) for a fallback. */
  priceFallbackDate: string;
  /**
   * True when `valueEur` could not be computed from any price (no live quote,
   * no last-known price, or no FX leg) and instead falls back to the last value
   * exported for this holding. The figure is then stale, not live.
   */
  valueIsStale: boolean;
  valueEur: Decimal | null;
  costBasisEur: Decimal | null;
  todayMoveEur: Decimal | null;
  todayMovePct: Decimal | null;
  /**
   * The FX-revaluation portion of `todayMoveEur` — how much of today's EUR move
   * came from the EUR/USD swing rather than the security's own price tick (the
   * remainder being the price move). Null when no today's move applies, or zero
   * for an EUR-native holding (FX cancels). See {@link buildHolding}.
   */
  todayFxMoveEur: Decimal | null;
  weight: Decimal | null;
  unrealisedPlEur: Decimal | null;
  /** Compounded total growth — (1+XIRR)^years over the holding's invested
   * lifetime (falls back to the simple gain/cost ratio when XIRR/years are
   * undefined). Shown on the holding card in place of weight. */
  totalGrowthPct: Decimal | null;
  xirr: Decimal | null;
  /**
   * USD companions (see currency.ts). `valueUsd`/`todayMoveUsd` mark the current
   * figure at today's spot; `costBasisUsd` uses the export's per-trade-date USD
   * cost basis; `totalGrowthPctUsd`/`xirrUsd` are recomputed in USD so the card
   * shows currency-correct growth when USD is selected. Null when USD is
   * unavailable, in which case the UI falls back to the EUR figure.
   */
  valueUsd: Decimal | null;
  costBasisUsd: Decimal | null;
  todayMoveUsd: Decimal | null;
  unrealisedPlUsd: Decimal | null;
  totalGrowthPctUsd: Decimal | null;
  xirrUsd: Decimal | null;
}

export interface OverviewView {
  generatedAt: string;
  asOf: string;
  /**
   * Epoch ms of the freshest live price observed across all holdings (the most
   * recent strike time), or null when nothing was priced live. Drives the
   * top-of-screen "updated …" stamp: shown as a clock time when it landed today
   * (a live stock/ETF), or a date when the latest data is older (NAV / closed
   * market).
   */
  liveAsOf: number | null;
  /** Export valuation date (`meta.as_of`), shown when `liveAsOf` is null. */
  liveAsOfFallbackDate: string;
  /**
   * Epoch ms of the last time fresh market data actually landed from the
   * network (a live quote or FX pull), or null when none yet this device.
   * Drives the "data last pulled …" footer + Refresh-button tooltip — *when we
   * last checked*, distinct from `liveAsOf` (when the prices themselves apply
   * to). Populated by the app shell after the model is built (it owns the
   * network), so the compute layer defaults it to null.
   */
  lastDataPullAt: number | null;
  totalValueEur: Decimal;
  cashValueEur: Decimal;
  totalCostBasisEur: Decimal;
  totalGainEur: Decimal;
  totalGainPct: Decimal | null;
  todayMoveEur: Decimal;
  todayMovePct: Decimal | null;
  /**
   * The FX-revaluation slice of `todayMoveEur` across all holdings — how much of
   * today's EUR move came from the EUR/USD swing rather than security prices.
   * The price-only contribution is `todayMoveEur − todayFxMoveEur`. Zero when
   * the move is FX-unaware (no live prior EUR/USD) or the book is EUR-only.
   */
  todayFxMoveEur: Decimal;
  /** Provenance of today's EUR/USD spot, for honest end-of-day-FX labelling. */
  eurUsdSource: EurUsdSourceLabel;
  /** EUR→USD at the prior session close used for the FX-aware move; null when unknown. */
  fxRateEurUsdPrev: Decimal | null;
  /** Month-to-date growth on the start-of-month value + net flows since. */
  mtdGrowthPct: Decimal | null;
  /** Year-to-date growth on the start-of-year value + net flows since. */
  ytdGrowthPct: Decimal | null;
  portfolioXirr: Decimal | null;
  /** Compounded (1+XIRR)^years total growth over the invested lifetime. */
  totalGrowthCompoundedPct: Decimal | null;
  /**
   * USD companions for the growth KPIs (see currency.ts). Absolute figures
   * (`totalValueUsd`, `totalGainUsd`, `todayMoveUsd`, `totalCostBasisUsd`) carry
   * the USD value at the appropriate FX (spot for current marks, per-trade-date
   * for cost basis); the percentage figures are recomputed in USD so toggling to
   * USD shows currency-correct growth. Null when USD is unavailable.
   */
  totalValueUsd: Decimal | null;
  totalCostBasisUsd: Decimal | null;
  totalGainUsd: Decimal | null;
  totalGainPctUsd: Decimal | null;
  todayMoveUsd: Decimal | null;
  mtdGrowthPctUsd: Decimal | null;
  ytdGrowthPctUsd: Decimal | null;
  portfolioXirrUsd: Decimal | null;
  totalGrowthCompoundedPctUsd: Decimal | null;
  /** Trailing dividend income (EUR) and its yield on current total value. */
  totalDividendsEur: Decimal;
  dividendYieldPct: Decimal | null;
  /** EUR→USD reference rate carried in the export meta (for the FX line). */
  fxRateEurUsd: Decimal | null;
  holdingsCount: number;
  /**
   * Symbols with no value at all — no live quote, no `last_known_price_native`,
   * and no exported fallback value — so they are excluded from totals.
   */
  missingPriceSymbols: string[];
  /**
   * Symbols whose value could not be computed live (no quote/last-known price,
   * or no FX leg) and instead falls back to the last exported value. They are
   * still counted in totals, but the figure is stale rather than live.
   */
  staleValueSymbols: string[];
  /** Currencies with no FX leg, so their EUR value could not be computed. */
  fxMissingCurrencies: string[];
  /**
   * True when every holding contributes a value to `totalValueEur` (live,
   * last-known, or exported fallback), so the total is a complete figure that
   * can be drawn as the live tip on the value chart. False only when a holding
   * dropped out entirely (no price, FX, or fallback), under-counting the total.
   */
  totalValueIsComplete: boolean;
  /**
   * Set when live quotes/FX could not be fetched (e.g. rate limited) and the
   * dashboard fell back to the exported last-known values; null otherwise.
   */
  liveDegradedReason: string | null;
  /**
   * A concise, descriptive summary of how much of the portfolio is currently
   * priced live (e.g. "13/18 up to date · stocks & ETFs done, 5 funds still
   * refreshing" or "All 18 holdings up to date"). Populated by the app shell
   * after a live refresh (it owns the network/report), so the compute layer
   * defaults it to null. Surfaced as a calm inline note — the transparency
   * compromise between an opaque "some prices not updated" and a floating banner.
   */
  liveCoverage: string | null;
  /**
   * Free-tier data credits spent so far in the rolling daily window, and the
   * daily cap. Populated by the app shell after the model is built (it owns the
   * network/credit log), so the compute layer defaults `dailyCreditsUsed` to
   * null. Drives the footer "data budget used today" line so the user can see
   * how many pulls they've made against the limit.
   */
  dailyCreditsUsed: number | null;
  dailyCreditLimit: number;
}

/** Portfolio allocation by asset class (holdings only, excludes cash). */
export interface AllocationSlice {
  label: string;
  valueEur: Decimal;
  weight: Decimal | null;
}

export interface DashboardModel {
  overview: OverviewView;
  holdings: HoldingView[];
  allocation: AllocationSlice[];
  /** Phase 4: monthly/yearly periods (current period recomputed live). */
  periods: PeriodsView;
  /** Phase 4: as-of-export analytics / risk display (null if not exported). */
  analytics: AnalyticsView | null;
  /** Phase 4: contributions / deposits summary (null if not exported). */
  deposits: DepositsView | null;
  /** Phase 4: forward-projection calculator seed inputs. */
  plan: PlanView;
}

/** Today's date as an ISO `YYYY-MM-DD` string in UTC (the live XIRR "now"). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** First day of the current month/year for `asOf` (ISO `YYYY-MM-DD`). */
function periodStartIso(asOf: string, kind: "month" | "year"): string {
  return kind === "month" ? `${asOf.slice(0, 7)}-01` : `${asOf.slice(0, 4)}-01-01`;
}

/**
 * Net external contributions on/after `startIso`, in the desktop's sign
 * convention (positive = money added). Exported `portfolio_cashflows` use the
 * XIRR convention (deposits negative), so we negate the sum.
 */
function netContributionsSince(cashflows: ExportCashflow[], startIso: string): Decimal {
  let sum = new Decimal(0);
  for (const cf of cashflows) {
    if (cf.date >= startIso) sum = sum.plus(new Decimal(cf.amount));
  }
  return sum.negated();
}

/**
 * USD parallel of {@link netContributionsSince}, summing each flow's
 * per-trade-date USD leg. Returns null when any in-range flow lacks a USD
 * amount (older exports), so the caller leaves USD period growth blank rather
 * than mixing per-date and spot conversions.
 */
function netContributionsSinceUsd(
  cashflows: ExportCashflow[],
  startIso: string,
): Decimal | null {
  let sum = new Decimal(0);
  for (const cf of cashflows) {
    if (cf.date < startIso) continue;
    if (cf.amount_usd === null || cf.amount_usd === undefined) return null;
    sum = sum.plus(new Decimal(cf.amount_usd));
  }
  return sum.negated();
}

/**
 * Period growth = (value − start − netContrib) / (start + netContrib), matching
 * the desktop's MTD/YTD growth. Returns `null` when there is no positive base
 * to grow from (e.g. a brand-new portfolio with no start-of-period value).
 */
function periodGrowth(
  totalValue: Decimal,
  startValue: Decimal,
  netContrib: Decimal,
): Decimal | null {
  const base = startValue.plus(netContrib);
  if (!base.greaterThan(0)) return null;
  return totalValue.minus(startValue).minus(netContrib).dividedBy(base);
}

function holdingCashflows(holding: ExportHolding): Cashflow[] {
  return holding.cashflows.map((cf) => ({ date: cf.date, amount: new Decimal(cf.amount) }));
}

/**
 * The per-trade-date USD leg of a holding's cashflows for a currency-correct USD
 * XIRR. Returns null when any flow lacks a USD amount (older exports) so the
 * caller leaves the USD XIRR blank and the UI falls back to the EUR figure
 * rather than mixing per-date and spot conversions.
 */
function holdingCashflowsUsd(holding: ExportHolding): Cashflow[] | null {
  const flows: Cashflow[] = [];
  for (const cf of holding.cashflows) {
    if (cf.amount_usd === null || cf.amount_usd === undefined) return null;
    flows.push({ date: cf.date, amount: new Decimal(cf.amount_usd) });
  }
  return flows;
}

/**
 * The most recent value (EUR) exported per holding symbol, used as a fallback
 * when live data cannot value a holding. Prefers the analytics attribution end
 * value (as of export); falls back to the holding's start-of-month/year opening
 * so a value is still available even when no analytics block was exported.
 */
function lastExportedValues(data: MobileExport): Map<string, Decimal> {
  const values = new Map<string, Decimal>();
  for (const [symbol, opening] of Object.entries(data.period_openings?.holdings ?? {})) {
    const candidate = opening.month_start_value_eur ?? opening.year_start_value_eur;
    if (candidate !== undefined && candidate !== null && candidate !== "") {
      values.set(symbol, new Decimal(candidate));
    }
  }
  // Attribution end values are as-of-export (newer than the period openings),
  // so they take precedence when present.
  for (const row of data.analytics?.attribution ?? []) {
    if (row.end_value !== null && row.end_value !== undefined) {
      values.set(row.symbol, new Decimal(row.end_value));
    }
  }
  return values;
}

/**
 * One symbol the live layer will request, with the context needed to order the
 * fetch *before* any live quote arrives.
 */
export interface FetchPlanEntry {
  /** The ticker passed to Twelve Data (`price_symbol`). */
  symbol: string;
  /** `market` for ETFs/stocks, or the NAV class for funds. */
  priceType: string;
  /** Asset class (e.g. `equity_etf`, `mutual_fund`), for downstream routing. */
  assetClass: string;
  /** Aggregated last-known EUR size across holdings sharing this ticker. */
  sizeEur: number;
}

/**
 * Build the priority-ordered list of symbols to price live, newest sizing first.
 *
 * Order (matching the app's own "biggest first" instinct, and so the most
 * impactful prices land first under the free-tier per-minute cap):
 *   1. **market** holdings (ETFs / stocks), largest EUR size first;
 *   2. then **NAV** holdings in `fetchableNavClasses` (mutual funds), largest first.
 *
 * Money-market / cash rows are excluded by passing only the genuinely fetchable
 * NAV classes in `fetchableNavClasses` (their NAV is pinned and never requested).
 * Sizes come from the last exported per-holding EUR value, so the order is
 * available without a fresh quote and is safe to cache between sessions.
 */
export function buildFetchPlan(data: MobileExport, fetchableNavClasses: Set<string>): FetchPlanEntry[] {
  const sizes = lastExportedValues(data);
  // Aggregate by ticker: multiple holdings can map to one price symbol.
  const bySymbol = new Map<string, FetchPlanEntry>();
  for (const holding of data.holdings) {
    // Money-market / settlement funds hold a constant $1.00 NAV by design, so a
    // quote only ever returns the same dollar and wastes a free-tier credit —
    // never fetch them, regardless of how they are otherwise classified.
    if (isMoneyMarketHolding(holding)) continue;
    const isMarket = holding.price_type === "market";
    const isFetchableNav = fetchableNavClasses.has(holding.asset_class);
    if (!isMarket && !isFetchableNav) continue;
    const symbol = holding.price_symbol;
    if (!symbol) continue;
    const sizeEur = sizes.get(holding.symbol)?.toNumber() ?? 0;
    const existing = bySymbol.get(symbol);
    if (existing) {
      existing.sizeEur += sizeEur;
      // Market priority wins if any holding on this ticker is market-priced.
      if (isMarket) existing.priceType = "market";
    } else {
      bySymbol.set(symbol, {
        symbol,
        priceType: holding.price_type,
        assetClass: holding.asset_class,
        sizeEur,
      });
    }
  }

  const rank = (e: FetchPlanEntry): number => (e.priceType === "market" ? 0 : 1);
  return [...bySymbol.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (b.sizeEur !== a.sizeEur) return b.sizeEur - a.sizeEur;
    return a.symbol.localeCompare(b.symbol); // stable, deterministic tiebreak
  });
}

/**
 * Is `iso` (a `YYYY-MM-DD` date) a weekday a fund could strike a NAV on?
 *
 * Defence-in-depth only: NAV value-dates now come from the daily `time_series`
 * endpoint, which already omits non-trading days, so a weekend date should never
 * reach here. We still reject one as a cheap guard against any feed quirk. The
 * date is read in UTC so the weekday is independent of the viewer's timezone.
 */
function isBusinessDayIso(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

function priceForHolding(
  holding: ExportHolding,
  quote: Quote | undefined,
  exportAsOf: string,
): {
  price: Decimal | null;
  isLive: boolean;
  at: number | null;
  /** Date to show when `at` is null (a NAV's value-date, or the export date). */
  asOfDate: string;
} {
  // When we fall back to the exported price, show *when that price was actually
  // struck* (the holding's last cached close date) rather than the export date —
  // a fund's NAV exported on a Sunday still applies to the Friday it last
  // published, never "today". Older exports omit `last_price_date`, so default
  // to the export's as-of date.
  const fallbackDate = holding.last_price_date ?? exportAsOf;
  if (quote && quote.price) {
    // NAV-priced holdings (mutual funds / money-market) publish only ~once a
    // trading day. Their live mark comes from the daily `time_series` endpoint,
    // whose latest bar is the genuine last-published NAV (it has no bar for a
    // weekend or a mid-week market holiday). A fresh Twelve Data pull is the
    // source of truth, so it overrides the exported value whenever its bar is
    // for the *same or a newer* trading day than the exported price — this lets
    // a re-fetch correct a stale or wrong value baked into the export/blob. We
    // only keep the exported value when the live bar is strictly *older* than
    // the price we already have (a closed-day carry-forward), so we never swap
    // the value backward onto an older basis.
    const navStale =
      holding.price_type === "nav" &&
      holding.last_known_price_native !== null &&
      !(quote.valueDate != null && quote.valueDate >= fallbackDate && isBusinessDayIso(quote.valueDate));
    if (!navStale) {
      // "as of" should reflect when the price actually applies, not when we
      // fetched it. Market quotes carry an intraday strike time (`priceTime`), so
      // a same-day price reads as a clock time; a daily NAV bar has only a date,
      // so we surface its value-date and the UI shows a date — never the fetch
      // time, which would mislabel a once-a-day NAV as "now".
      const isNav = holding.price_type === "nav";
      return {
        price: quote.price,
        isLive: true,
        at: isNav ? (quote.priceTime ?? null) : (quote.priceTime ?? quote.at ?? null),
        asOfDate: quote.valueDate ?? fallbackDate,
      };
    }
  }
  if (holding.last_known_price_native !== null) {
    return { price: new Decimal(holding.last_known_price_native), isLive: false, at: null, asOfDate: fallbackDate };
  }
  return { price: null, isLive: false, at: null, asOfDate: fallbackDate };
}

function buildHolding(
  holding: ExportHolding,
  quote: Quote | undefined,
  fx: FxRates,
  fxPrev: FxRates,
  asOf: string,
  fxMissing: Set<string>,
  exportAsOf: string,
  fallbackValueEur: Decimal | null,
): HoldingView {
  const shares = new Decimal(holding.shares);
  const { price, isLive, at, asOfDate } = priceForHolding(holding, quote, exportAsOf);
  const currency = holding.native_currency;

  let valueEur: Decimal | null = null;
  if (price !== null) {
    const valueNative = shares.times(price);
    valueEur = convert(valueNative, currency, EUR, fx);
  }

  // When no price/FX could value the holding, fall back to the last value
  // exported for it so it still counts toward the total (with a stale flag),
  // rather than silently dropping out and dragging the headline/chart down.
  let valueIsStale = false;
  if (valueEur === null && fallbackValueEur !== null) {
    valueEur = fallbackValueEur;
    valueIsStale = true;
  }

  // Only flag a genuinely missing FX leg when it actually left the holding
  // unvalued (no fallback recovered it).
  if (valueEur === null && price !== null && currency !== EUR) fxMissing.add(currency);

  // Cost basis in EUR. Prefer the export's per-trade-date EUR figure (the EUR
  // the buys actually cost) so EUR growth reflects FX drift between the trade
  // dates and now; fall back to converting the native cost at today's spot for
  // older exports without the field. Deriving it at today's spot makes EUR and
  // USD growth identical (both collapse to the native growth), which is exactly
  // the "growth doesn't change with currency" bug this avoids.
  const costBasisEur =
    holding.cost_basis_eur !== null && holding.cost_basis_eur !== undefined
      ? new Decimal(holding.cost_basis_eur)
      : convert(new Decimal(holding.cost_basis_native), currency, EUR, fx);

  // Today's move is the change in the holding's *value* from the prior published
  // close to the price we display, for any holding that carries a previous close:
  //   - market rows (stocks / ETFs): the latest session's move from the `quote`
  //     endpoint's `previous_close`, but only while that live quote is the one on
  //     screen (`isLive`);
  //   - NAV rows (mutual funds): the latest published NAV's move from the prior
  //     daily `time_series` bar. A fund publishes ~once a day, so the export
  //     usually already carries its newest NAV; we still want it to show the same
  //     last-session move a stock does (e.g. last Friday's move over a weekend)
  //     rather than a blank — even when the row stays on its exported price.
  // The one quote we must never derive a move from is a *stale, older* NAV bar
  // (its value-date is behind the price we display): then `previous_close` is two
  // sessions back and would mislabel an old move as today's. We guard NAV moves
  // on `valueDate >= asOfDate` (the bar is current with the displayed price) and
  // take the fund's own session move (its daily bar vs that bar's prior close).
  // Money-market NAVs are pinned at $1 and never fetched, so they have no
  // previous close and correctly contribute no move.
  //
  // The EUR move is **FX-aware**: it revalues the current mark at today's EUR→USD
  // (`fx`) and the prior mark at the prior session's EUR→USD (`fxPrev`), so for a
  // USD holding it captures both the security move *and* the EUR/USD revaluation
  // of the whole position — not just the price tick. The USD move stays
  // FX-neutral (the native price change converted at a single rate), and the
  // difference between the two is the FX contribution surfaced separately.
  let todayMoveEur: Decimal | null = null;
  let todayMovePct: Decimal | null = null;
  let todayMoveUsd: Decimal | null = null;
  let todayFxMoveEur: Decimal | null = null;
  const previousClose = quote?.previousClose ?? null;
  const quotePrice = quote?.price ?? null;
  const hasPriorClose = previousClose !== null && !previousClose.isZero();
  const moveApplies =
    hasPriorClose &&
    quotePrice !== null &&
    (holding.price_type === "nav"
      ? quote?.valueDate != null && quote.valueDate >= asOfDate
      : isLive);
  if (moveApplies && quotePrice !== null && previousClose !== null) {
    const valueNowNative = quotePrice.times(shares);
    const valuePrevNative = previousClose.times(shares);
    // FX-aware EUR move: current mark at `fx`, prior mark at `fxPrev`.
    const valueNowEur = convert(valueNowNative, currency, EUR, fx);
    const valuePrevEur = convert(valuePrevNative, currency, EUR, fxPrev);
    if (valueNowEur !== null && valuePrevEur !== null) {
      todayMoveEur = valueNowEur.minus(valuePrevEur);
      todayMovePct = valuePrevEur.greaterThan(0)
        ? todayMoveEur.dividedBy(valuePrevEur)
        : null;
      // The price-only EUR move (both marks at today's FX) — the FX-neutral part
      // expressed in EUR; the remainder of the FX-aware move is the FX swing.
      const priceMoveEur = convert(
        quotePrice.minus(previousClose).times(shares),
        currency,
        EUR,
        fx,
      );
      todayFxMoveEur = priceMoveEur !== null ? todayMoveEur.minus(priceMoveEur) : null;
    }
    // FX-neutral USD move: native price change at today's spot only.
    todayMoveUsd = convert(quotePrice.minus(previousClose).times(shares), currency, USD, fx);
  }

  const unrealisedPlEur =
    valueEur !== null && costBasisEur !== null ? valueEur.minus(costBasisEur) : null;

  // Simple total growth on cost (price-based, dividends excluded): the
  // holding's unrealised P/L as a fraction of what it cost. Kept only as a
  // fallback for the compounded figure below. Null when there is no cost basis
  // to grow from (e.g. a fully gifted/spun-off position).
  const simpleGrowthPct =
    unrealisedPlEur !== null && costBasisEur !== null && costBasisEur.greaterThan(0)
      ? unrealisedPlEur.dividedBy(costBasisEur)
      : null;

  const holdingFlows = holdingCashflows(holding);
  const xirrRate =
    valueEur !== null && valueEur.greaterThan(0)
      ? xirr(holdingFlows, asOf, { terminalValue: valueEur })
      : null;

  // Total Growth mirrors the desktop + portfolio headline: the compounded
  // (1+XIRR)^years return over the time actually invested in this holding,
  // rather than a simple gain/cost ratio. The ratio badly understates holdings
  // the user is still buying into regularly (a large, recently-added cost basis
  // has had little time to grow). ``years`` runs from the holding's first
  // cashflow to ``asOf``; when the compounded figure is undefined we fall back
  // to the simple ratio so a brand-new holding still reads a sensible number.
  const firstFlowDate = holdingFlows.reduce<string | null>(
    (min, cf) => (min === null || cf.date < min ? cf.date : min),
    null,
  );
  const heldYears = firstFlowDate !== null ? yearsBetween(firstFlowDate, asOf) : new Decimal(0);
  const totalGrowthPct = totalGrowthPctCompounded(xirrRate, heldYears) ?? simpleGrowthPct;

  // --- USD companions (currency-correct growth when USD is selected) --------
  // Current marks use today's spot (matching the desktop's terminal-value
  // treatment); the cost basis uses the export's per-trade-date USD figure.
  const valueUsd = valueEur !== null ? convert(valueEur, EUR, USD, fx) : null;
  const costBasisUsd =
    holding.cost_basis_usd !== null && holding.cost_basis_usd !== undefined
      ? new Decimal(holding.cost_basis_usd)
      : costBasisEur !== null
        ? convert(costBasisEur, EUR, USD, fx)
        : null;
  const unrealisedPlUsd =
    valueUsd !== null && costBasisUsd !== null ? valueUsd.minus(costBasisUsd) : null;
  const simpleGrowthPctUsd =
    unrealisedPlUsd !== null && costBasisUsd !== null && costBasisUsd.greaterThan(0)
      ? unrealisedPlUsd.dividedBy(costBasisUsd)
      : null;
  const usdFlows = holdingCashflowsUsd(holding);
  const xirrUsd =
    usdFlows !== null && valueUsd !== null && valueUsd.greaterThan(0)
      ? xirr(usdFlows, asOf, { terminalValue: valueUsd })
      : null;
  // Compounded USD total growth over the same invested horizon (falls back to
  // the simple USD ratio when the compounded figure is undefined).
  const totalGrowthPctUsd =
    totalGrowthPctCompounded(xirrUsd, heldYears) ?? simpleGrowthPctUsd;

  return {
    symbol: holding.symbol,
    name: holding.name ?? holding.symbol,
    assetClass: holding.asset_class,
    broker: holding.broker,
    account: holding.account,
    nativeCurrency: currency,
    priceType: holding.price_type,
    shares,
    priceNative: price,
    priceIsLive: isLive,
    priceAsOf: at,
    priceFallbackDate: asOfDate,
    valueIsStale,
    valueEur,
    costBasisEur,
    todayMoveEur,
    todayMovePct,
    todayFxMoveEur,
    weight: null, // filled once the portfolio total is known
    unrealisedPlEur,
    totalGrowthPct,
    xirr: xirrRate,
    valueUsd,
    costBasisUsd,
    todayMoveUsd,
    unrealisedPlUsd,
    totalGrowthPctUsd,
    xirrUsd,
  };
}

/**
 * USD parallel of the portfolio cashflow stream (per-trade-date USD legs).
 * Returns null when any flow lacks a USD amount so the USD XIRR is left blank
 * rather than mixing per-date and spot conversions.
 */
function buildPortfolioCashflowsUsd(cashflows: ExportCashflow[]): Cashflow[] | null {
  const flows: Cashflow[] = [];
  for (const cf of cashflows) {
    if (cf.amount_usd === null || cf.amount_usd === undefined) return null;
    flows.push({ date: cf.date, amount: new Decimal(cf.amount_usd) });
  }
  return flows;
}

/** Provenance of the EUR/USD spot driving the live current marks + today's move. */
export type EurUsdSourceLabel = "live" | "eod" | "cache" | "none";

/** Optional live-FX inputs that make today's move FX-aware. */
export interface BuildDashboardOptions {
  /**
   * EUR→USD at the prior session close (USD per 1 EUR). When provided, the
   * prior mark of each holding's today's move is revalued at this rate while the
   * current mark uses `fx` — capturing the intraday EUR/USD swing on the held
   * position. When null/omitted the prior mark uses today's rate too, so the
   * move stays FX-unaware (back-compatible).
   */
  fxPrevEurUsd?: Decimal | null;
  /** Where today's EUR/USD spot came from, for honest UI labelling. */
  fxEurUsdSource?: EurUsdSourceLabel;
}

/** Build the full dashboard model from the decrypted export + live data. */
export function buildDashboard(
  data: MobileExport,
  quotes: Map<string, Quote>,
  fx: FxRates,
  now: Date = new Date(),
  liveDegradedReason: string | null = null,
  opts: BuildDashboardOptions = {},
): DashboardModel {
  const asOf = todayIso(now);
  const exportAsOf = data.meta.as_of || asOf;
  const fxMissing = new Set<string>();
  const missingPrice: string[] = [];
  const staleValue: string[] = [];

  // The previous-close FX snapshot for an FX-aware today's move: today's rates
  // with EUR→USD swapped for the prior session's close. When no prior EUR/USD is
  // known, `fxPrev` is just `fx`, so the move degrades to FX-unaware rather than
  // inventing a swing.
  const fxPrevEurUsd = opts.fxPrevEurUsd ?? null;
  const fxPrev: FxRates =
    fxPrevEurUsd !== null && fxPrevEurUsd.greaterThan(0)
      ? { base: fx.base, rates: { ...fx.rates, USD: fxPrevEurUsd } }
      : fx;

  // Last value exported per holding (EUR), used as a fallback when no live
  // price/FX can value it. Sourced from the analytics attribution end values.
  const fallbackValues = lastExportedValues(data);

  const holdings = data.holdings.map((h) => {
    const view = buildHolding(
      h,
      quotes.get(h.price_symbol),
      fx,
      fxPrev,
      asOf,
      fxMissing,
      exportAsOf,
      fallbackValues.get(h.symbol) ?? null,
    );
    // A holding with no value at all (no price, FX, or fallback) is dropped from
    // totals; one valued from the export fallback is counted but flagged stale.
    if (view.valueEur === null) missingPrice.push(h.symbol);
    else if (view.valueIsStale) staleValue.push(h.symbol);
    return view;
  });

  // Cash / savings balances count toward total value as-is (converted to EUR).
  let cashValueEur = new Decimal(0);
  for (const row of data.cash) {
    const eur = convert(new Decimal(row.balance_native), row.native_currency, EUR, fx);
    if (eur === null) {
      if (row.native_currency !== EUR) fxMissing.add(row.native_currency);
      continue;
    }
    cashValueEur = cashValueEur.plus(eur);
  }

  const holdingsValueEur = holdings.reduce(
    (acc, h) => (h.valueEur !== null ? acc.plus(h.valueEur) : acc),
    new Decimal(0),
  );
  const totalValueEur = holdingsValueEur.plus(cashValueEur);

  for (const h of holdings) {
    h.weight = h.valueEur !== null && totalValueEur.greaterThan(0) ? h.valueEur.dividedBy(totalValueEur) : null;
  }

  const totalCostBasisEur = holdings.reduce(
    (acc, h) => (h.costBasisEur !== null ? acc.plus(h.costBasisEur) : acc),
    new Decimal(0),
  );
  const todayMoveEur = holdings.reduce(
    (acc, h) => (h.todayMoveEur !== null ? acc.plus(h.todayMoveEur) : acc),
    new Decimal(0),
  );
  // The FX-revaluation slice of today's move, summed across holdings; the
  // remainder (`todayMoveEur − todayFxMoveEur`) is the price-only contribution.
  const todayFxMoveEur = holdings.reduce(
    (acc, h) => (h.todayFxMoveEur !== null ? acc.plus(h.todayFxMoveEur) : acc),
    new Decimal(0),
  );

  // Gain reflects the market holdings' unrealised P/L (value − cost basis);
  // cash carries no cost basis so it is excluded from the gain figure.
  const totalGainEur = holdingsValueEur.minus(totalCostBasisEur);
  const totalGainPct = totalCostBasisEur.greaterThan(0)
    ? totalGainEur.dividedBy(totalCostBasisEur)
    : null;

  const prevTotal = totalValueEur.minus(todayMoveEur);
  const todayMovePct = prevTotal.greaterThan(0) ? todayMoveEur.dividedBy(prevTotal) : null;

  // Month/year-to-date growth, recomputed live against the exported period
  // openings (start-of-period portfolio value) and the net external flows
  // booked since. `meta.as_of` anchors the period so the boundaries align with
  // the openings captured at export time.
  const periodAnchor = data.meta.as_of || asOf;
  const monthStartValue = new Decimal(data.period_openings?.month_start_value_eur ?? "0");
  const yearStartValue = new Decimal(data.period_openings?.year_start_value_eur ?? "0");
  const mtdGrowthPct = periodGrowth(
    totalValueEur,
    monthStartValue,
    netContributionsSince(data.portfolio_cashflows, periodStartIso(periodAnchor, "month")),
  );
  const ytdGrowthPct = periodGrowth(
    totalValueEur,
    yearStartValue,
    netContributionsSince(data.portfolio_cashflows, periodStartIso(periodAnchor, "year")),
  );

  const portfolioCashflows: Cashflow[] = data.portfolio_cashflows.map((cf) => ({
    date: cf.date,
    amount: new Decimal(cf.amount),
  }));
  const portfolioXirr = totalValueEur.greaterThan(0)
    ? xirr(portfolioCashflows, asOf, { terminalValue: totalValueEur })
    : null;

  // Total Growth (compounded): the (1+XIRR)^years return over the lifetime the
  // money has actually been invested — the desktop overview's headline growth.
  const firstCashflowDate = data.portfolio_cashflows.reduce<string | null>(
    (earliest, cf) => (earliest === null || cf.date < earliest ? cf.date : earliest),
    null,
  );
  const totalGrowthCompoundedPct =
    firstCashflowDate !== null
      ? totalGrowthPctCompounded(portfolioXirr, yearsBetween(firstCashflowDate, asOf))
      : null;

  // Trailing dividend yield = total dividend cash ÷ current total value
  // (mirrors the desktop's Dividends ÷ Closing Balance).
  let totalDividendsEur = new Decimal(0);
  for (const holding of data.holdings) {
    const eur = convert(
      new Decimal(holding.cumulative_dividends_cash_native),
      holding.native_currency,
      EUR,
      fx,
    );
    if (eur !== null) totalDividendsEur = totalDividendsEur.plus(eur);
  }
  const dividendYieldPct = totalValueEur.greaterThan(0)
    ? totalDividendsEur.dividedBy(totalValueEur)
    : null;

  const fxRateEurUsd =
    fx.rates.USD ?? // the live/loaded spot that valued the current marks
    (data.meta.fx_rate_eur_usd !== null && data.meta.fx_rate_eur_usd !== undefined
      ? new Decimal(data.meta.fx_rate_eur_usd)
      : null);

  // --- USD companions for the growth KPIs -----------------------------------
  // Current marks (value, today's move) use today's spot; the cost basis uses
  // the export's per-trade-date USD figures. The percentage KPIs are recomputed
  // in USD so toggling currency shows currency-correct growth. Everything is
  // null when USD is unavailable (no live/known EUR→USD rate), in which case the
  // UI falls back to the EUR figure.
  const holdingsValueUsd = convert(holdingsValueEur, EUR, USD, fx);
  const totalValueUsd = convert(totalValueEur, EUR, USD, fx);
  const totalCostBasisUsd = holdings.reduce<Decimal | null>(
    (acc, h) => (acc !== null && h.costBasisUsd !== null ? acc.plus(h.costBasisUsd) : acc),
    holdingsValueUsd === null ? null : new Decimal(0),
  );
  // FX-neutral USD today's move: the sum of each holding's native price change
  // at today's spot (never a rescale of the FX-aware EUR move, which would
  // double-count the EUR/USD swing). Null when no holding could be valued in USD.
  const todayMoveUsd = holdings.reduce<Decimal | null>(
    (acc, h) => (acc !== null && h.todayMoveUsd !== null ? acc.plus(h.todayMoveUsd) : acc),
    holdingsValueUsd === null ? null : new Decimal(0),
  );
  const totalGainUsd =
    holdingsValueUsd !== null && totalCostBasisUsd !== null
      ? holdingsValueUsd.minus(totalCostBasisUsd)
      : null;
  const totalGainPctUsd =
    totalGainUsd !== null && totalCostBasisUsd !== null && totalCostBasisUsd.greaterThan(0)
      ? totalGainUsd.dividedBy(totalCostBasisUsd)
      : null;

  const monthStartValueUsdRaw = data.period_openings?.month_start_value_usd;
  const yearStartValueUsdRaw = data.period_openings?.year_start_value_usd;
  const monthNetContribUsd = netContributionsSinceUsd(
    data.portfolio_cashflows,
    periodStartIso(periodAnchor, "month"),
  );
  const yearNetContribUsd = netContributionsSinceUsd(
    data.portfolio_cashflows,
    periodStartIso(periodAnchor, "year"),
  );
  const mtdGrowthPctUsd =
    totalValueUsd !== null &&
    monthStartValueUsdRaw !== null &&
    monthStartValueUsdRaw !== undefined &&
    monthNetContribUsd !== null
      ? periodGrowth(totalValueUsd, new Decimal(monthStartValueUsdRaw), monthNetContribUsd)
      : null;
  const ytdGrowthPctUsd =
    totalValueUsd !== null &&
    yearStartValueUsdRaw !== null &&
    yearStartValueUsdRaw !== undefined &&
    yearNetContribUsd !== null
      ? periodGrowth(totalValueUsd, new Decimal(yearStartValueUsdRaw), yearNetContribUsd)
      : null;

  const portfolioCashflowsUsd = buildPortfolioCashflowsUsd(data.portfolio_cashflows);
  const portfolioXirrUsd =
    portfolioCashflowsUsd !== null && totalValueUsd !== null && totalValueUsd.greaterThan(0)
      ? xirr(portfolioCashflowsUsd, asOf, { terminalValue: totalValueUsd })
      : null;
  const totalGrowthCompoundedPctUsd =
    firstCashflowDate !== null && portfolioXirrUsd !== null
      ? totalGrowthPctCompounded(portfolioXirrUsd, yearsBetween(firstCashflowDate, asOf))
      : null;

  // Allocation by asset class (holdings only — cash is reported separately),
  // mirroring the desktop overview's allocation breakdown.
  const allocation = buildAllocation(holdings, holdingsValueEur);

  const overview: OverviewView = {
    generatedAt: data.meta.generated_at,
    asOf,
    liveAsOf: holdings.reduce<number | null>(
      (latest, h) =>
        h.priceAsOf !== null && (latest === null || h.priceAsOf > latest) ? h.priceAsOf : latest,
      null,
    ),
    // When nothing was priced intraday (e.g. a fund-only portfolio over a
    // weekend), the top stamp shows the newest date we do know — the latest
    // holding value-date, or the export date.
    liveAsOfFallbackDate: holdings.reduce<string>(
      (latest, h) => (h.priceFallbackDate > latest ? h.priceFallbackDate : latest),
      exportAsOf,
    ),
    lastDataPullAt: null,
    dailyCreditsUsed: null,
    dailyCreditLimit: FREE_TIER_CREDITS_PER_DAY,
    totalValueEur,
    cashValueEur,
    totalCostBasisEur,
    totalGainEur,
    totalGainPct,
    todayMoveEur,
    todayMovePct,
    todayFxMoveEur,
    eurUsdSource: opts.fxEurUsdSource ?? "none",
    fxRateEurUsdPrev: fxPrevEurUsd,
    mtdGrowthPct,
    ytdGrowthPct,
    portfolioXirr,
    totalGrowthCompoundedPct,
    totalValueUsd,
    totalCostBasisUsd,
    totalGainUsd,
    totalGainPctUsd,
    todayMoveUsd,
    mtdGrowthPctUsd,
    ytdGrowthPctUsd,
    portfolioXirrUsd,
    totalGrowthCompoundedPctUsd,
    totalDividendsEur,
    dividendYieldPct,
    fxRateEurUsd,
    holdingsCount: holdings.length,
    missingPriceSymbols: missingPrice,
    staleValueSymbols: staleValue,
    fxMissingCurrencies: [...fxMissing],
    totalValueIsComplete: missingPrice.length === 0 && fxMissing.size === 0,
    liveDegradedReason,
    liveCoverage: null,
  };

  const periods = buildPeriods(data, overview);
  const analytics = buildAnalytics(data);
  const deposits = buildDeposits(data);
  const plan = buildPlan(data, overview);

  return { overview, holdings, allocation, periods, analytics, deposits, plan };
}

/**
 * Today's EUR/USD move as a fraction (e.g. `0.0032` = +0.32%): the current spot
 * versus the prior session close. This is the *cause* of the portfolio's FX
 * P/L slice — surfaced alongside it so the user sees both the money the FX swing
 * moved and the rate change behind it. Null when either rate is unknown or the
 * prior close is non-positive.
 */
export function fxTodayDeviationPct(o: OverviewView): Decimal | null {
  const now = o.fxRateEurUsd;
  const prev = o.fxRateEurUsdPrev;
  if (now === null || prev === null || !prev.greaterThan(0)) return null;
  return now.minus(prev).dividedBy(prev);
}

/** Group holding values by asset class into descending allocation slices. */
function buildAllocation(holdings: HoldingView[], holdingsValueEur: Decimal): AllocationSlice[] {
  const byClass = new Map<string, Decimal>();
  for (const holding of holdings) {
    if (holding.valueEur === null) continue;
    const label = holding.assetClass || "other";
    byClass.set(label, (byClass.get(label) ?? new Decimal(0)).plus(holding.valueEur));
  }
  return [...byClass.entries()]
    .map(([label, valueEur]) => ({
      label,
      valueEur,
      weight: holdingsValueEur.greaterThan(0) ? valueEur.dividedBy(holdingsValueEur) : null,
    }))
    .sort((a, b) => b.valueEur.minus(a.valueEur).toNumber());
}
