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
   * Symbols with no usable price at all — no live quote and no
   * `last_known_price_native` fallback — so they are excluded from totals.
   */
  missingPriceSymbols: string[];
  /** Currencies with no FX leg, so their EUR value could not be computed. */
  fxMissingCurrencies: string[];
  /**
   * True when every holding could be valued in EUR, so `totalValueEur` is a
   * complete figure. False when some holdings fell out of the sum because they
   * had no usable price or no FX rate — in that case the total under-counts the
   * portfolio and must not be drawn as a live tip on the value chart.
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

function priceForHolding(holding: ExportHolding, quote: Quote | undefined): {
  price: Decimal | null;
  isLive: boolean;
} {
  if (quote && quote.price) return { price: quote.price, isLive: true };
  if (holding.last_known_price_native !== null) {
    return { price: new Decimal(holding.last_known_price_native), isLive: false };
  }
  return { price: null, isLive: false };
}

function buildHolding(
  holding: ExportHolding,
  quote: Quote | undefined,
  fx: FxRates,
  asOf: string,
  fxMissing: Set<string>,
): HoldingView {
  const shares = new Decimal(holding.shares);
  const { price, isLive } = priceForHolding(holding, quote);
  const currency = holding.native_currency;

  let valueEur: Decimal | null = null;
  if (price !== null) {
    const valueNative = shares.times(price);
    valueEur = convert(valueNative, currency, EUR, fx);
    if (valueEur === null && currency !== EUR) fxMissing.add(currency);
  }

  const costBasisEur = convert(new Decimal(holding.cost_basis_native), currency, EUR, fx);
  if (costBasisEur === null && currency !== EUR) fxMissing.add(currency);

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
  const fxMissing = new Set<string>();
  const missingPrice: string[] = [];

  const holdings = data.holdings.map((h) => {
    const view = buildHolding(h, quotes.get(h.price_symbol), fx, asOf, fxMissing);
    if (view.priceNative === null) missingPrice.push(h.symbol);
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
