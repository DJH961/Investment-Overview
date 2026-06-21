/**
 * Live computation layer: combine the decrypted export with live quotes + FX
 * into the Overview KPIs and per-holding rows the UI renders.
 *
 * Phase 3 scope (proposal §9): the live "how am I doing right now" view —
 * total value, today's move, total gain, and XIRR (portfolio and per holding),
 * all in EUR. Completed-period and analytics *display* is Phase 4; those blocks
 * ride along in the export but are not surfaced here yet.
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

const EUR = "EUR";

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
  weight: Decimal | null;
  unrealisedPlEur: Decimal | null;
  xirr: Decimal | null;
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
  totalValueEur: Decimal;
  cashValueEur: Decimal;
  totalCostBasisEur: Decimal;
  totalGainEur: Decimal;
  totalGainPct: Decimal | null;
  todayMoveEur: Decimal;
  todayMovePct: Decimal | null;
  /** Month-to-date growth on the start-of-month value + net flows since. */
  mtdGrowthPct: Decimal | null;
  /** Year-to-date growth on the start-of-year value + net flows since. */
  ytdGrowthPct: Decimal | null;
  portfolioXirr: Decimal | null;
  /** Compounded (1+XIRR)^years total growth over the invested lifetime. */
  totalGrowthCompoundedPct: Decimal | null;
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

  const costBasisEur = convert(new Decimal(holding.cost_basis_native), currency, EUR, fx);

  // Today's move only applies to market-priced rows with a live previous close.
  let todayMoveEur: Decimal | null = null;
  let todayMovePct: Decimal | null = null;
  if (holding.price_type === "market" && quote?.price && quote.previousClose && !quote.previousClose.isZero()) {
    const moveNative = quote.price.minus(quote.previousClose).times(shares);
    todayMoveEur = convert(moveNative, currency, EUR, fx);
    todayMovePct = quote.price.minus(quote.previousClose).dividedBy(quote.previousClose);
  }

  const unrealisedPlEur =
    valueEur !== null && costBasisEur !== null ? valueEur.minus(costBasisEur) : null;

  const xirrRate =
    valueEur !== null && valueEur.greaterThan(0)
      ? xirr(holdingCashflows(holding), asOf, { terminalValue: valueEur })
      : null;

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
    weight: null, // filled once the portfolio total is known
    unrealisedPlEur,
    xirr: xirrRate,
  };
}

/** Build the full dashboard model from the decrypted export + live data. */
export function buildDashboard(
  data: MobileExport,
  quotes: Map<string, Quote>,
  fx: FxRates,
  now: Date = new Date(),
  liveDegradedReason: string | null = null,
): DashboardModel {
  const asOf = todayIso(now);
  const exportAsOf = data.meta.as_of || asOf;
  const fxMissing = new Set<string>();
  const missingPrice: string[] = [];
  const staleValue: string[] = [];

  // Last value exported per holding (EUR), used as a fallback when no live
  // price/FX can value it. Sourced from the analytics attribution end values.
  const fallbackValues = lastExportedValues(data);

  const holdings = data.holdings.map((h) => {
    const view = buildHolding(
      h,
      quotes.get(h.price_symbol),
      fx,
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
    data.meta.fx_rate_eur_usd !== null && data.meta.fx_rate_eur_usd !== undefined
      ? new Decimal(data.meta.fx_rate_eur_usd)
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
    totalValueEur,
    cashValueEur,
    totalCostBasisEur,
    totalGainEur,
    totalGainPct,
    todayMoveEur,
    todayMovePct,
    mtdGrowthPct,
    ytdGrowthPct,
    portfolioXirr,
    totalGrowthCompoundedPct,
    totalDividendsEur,
    dividendYieldPct,
    fxRateEurUsd,
    holdingsCount: holdings.length,
    missingPriceSymbols: missingPrice,
    staleValueSymbols: staleValue,
    fxMissingCurrencies: [...fxMissing],
    totalValueIsComplete: missingPrice.length === 0 && fxMissing.size === 0,
    liveDegradedReason,
  };

  const periods = buildPeriods(data, overview);
  const analytics = buildAnalytics(data);
  const deposits = buildDeposits(data);
  const plan = buildPlan(data, overview);

  return { overview, holdings, allocation, periods, analytics, deposits, plan };
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
