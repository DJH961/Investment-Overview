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
import { xirr, type Cashflow } from "./returns";
import type { ExportHolding, MobileExport } from "./types";

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
  portfolioXirr: Decimal | null;
  holdingsCount: number;
  /** Symbols whose live price was unavailable (NAV stale or unsupported). */
  missingPriceSymbols: string[];
  /** Currencies with no FX leg, so their EUR value could not be computed. */
  fxMissingCurrencies: string[];
}

export interface DashboardModel {
  overview: OverviewView;
  holdings: HoldingView[];
}

/** Today's date as an ISO `YYYY-MM-DD` string in UTC (the live XIRR "now"). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
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

  const portfolioCashflows: Cashflow[] = data.portfolio_cashflows.map((cf) => ({
    date: cf.date,
    amount: new Decimal(cf.amount),
  }));
  const portfolioXirr = totalValueEur.greaterThan(0)
    ? xirr(portfolioCashflows, asOf, { terminalValue: totalValueEur })
    : null;

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
    portfolioXirr,
    holdingsCount: holdings.length,
    missingPriceSymbols: missingPrice,
    fxMissingCurrencies: [...fxMissing],
  };

  return { overview, holdings };
}
