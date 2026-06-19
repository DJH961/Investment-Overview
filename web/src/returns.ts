/**
 * Browser port of `investment_dashboard/domain/returns.py`.
 *
 * These are the *leaf* return/growth functions the desktop app uses to compute
 * XIRR, CAGR, and the simple growth variants. They are ported 1:1 so the web
 * companion shows the exact same numbers as the desktop, and they are guarded
 * by the parity suite in `test/returns.parity.test.ts`, which replays the
 * committed `tests/parity/vectors.json` produced from the Python source.
 *
 * Cashflow sign convention (matches the Python module):
 *   - contributions into the portfolio (buy/deposit) are NEGATIVE,
 *   - withdrawals out (sell/dividend/interest) are POSITIVE,
 *   - the terminal mark-to-market value is appended as a single POSITIVE flow.
 *
 * Where the Python uses `decimal.Decimal` we use decimal.js `Decimal`; where it
 * deliberately drops to `float` (the XIRR solver and the fractional-power
 * paths) we use the JS `number` double, which is the same IEEE-754 binary64.
 */

import Decimal from "decimal.js";

/** Calendar-day constants mirroring the Python module. */
const DAYS_PER_YEAR_FLOAT = 365.0;
const DAYS_PER_YEAR = new Decimal("365.0");
const DAYS_PER_CALENDAR_YEAR = new Decimal("365.25");

export interface Cashflow {
  /** ISO-8601 date string (YYYY-MM-DD). */
  date: string;
  amount: Decimal;
}

/** Whole calendar days from `from` to `to` (UTC, matching Python date math). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// -----------------------------------------------------------------------------
// XIRR (float Newton-Raphson with a bisection fallback — see returns.py)
// -----------------------------------------------------------------------------

function npv(rate: number, flows: Cashflow[], asOf: string): number {
  const base = 1.0 + rate;
  let total = 0.0;
  for (const cf of flows) {
    const years = daysBetween(cf.date, asOf) / DAYS_PER_YEAR_FLOAT;
    total += cf.amount.toNumber() * base ** years;
  }
  return total;
}

function npvDerivative(rate: number, flows: Cashflow[], asOf: string): number {
  const base = 1.0 + rate;
  let total = 0.0;
  for (const cf of flows) {
    const years = daysBetween(cf.date, asOf) / DAYS_PER_YEAR_FLOAT;
    if (years === 0) continue;
    total += years * cf.amount.toNumber() * base ** (years - 1.0);
  }
  return total;
}

export interface XirrOptions {
  terminalValue?: Decimal | null;
  guess?: number;
  tol?: number;
  maxIter?: number;
}

/**
 * Annualised internal rate of return for an irregular cashflow stream.
 * Returns `null` when there are fewer than two flows, all flows share one sign,
 * or the solver fails to converge — exactly like the Python implementation.
 */
export function xirr(
  cashflows: Cashflow[],
  asOf: string,
  options: XirrOptions = {},
): Decimal | null {
  const { terminalValue = null, guess = 0.1, tol = 1e-7, maxIter = 100 } = options;

  const flows: Cashflow[] = [...cashflows];
  if (terminalValue !== null && terminalValue !== undefined && !terminalValue.isZero()) {
    flows.push({ date: asOf, amount: terminalValue });
  }
  if (flows.length < 2) return null;

  const signs = new Set<number>();
  for (const cf of flows) {
    if (cf.amount.greaterThan(0)) signs.add(1);
    else if (cf.amount.lessThan(0)) signs.add(-1);
  }
  if (signs.size < 2) return null;

  // --- Newton-Raphson ---
  let rate = guess;
  for (let i = 0; i < maxIter; i += 1) {
    const f = npv(rate, flows, asOf);
    if (Math.abs(f) < tol) return new Decimal(rate);
    const fp = npvDerivative(rate, flows, asOf);
    if (fp === 0) break;
    let nextRate = rate - f / fp;
    if (nextRate <= -0.9999) {
      nextRate = (rate + -0.9999) / 2.0;
    }
    if (Number.isNaN(nextRate) || !Number.isFinite(nextRate)) break;
    if (Math.abs(nextRate - rate) < tol) return new Decimal(nextRate);
    rate = nextRate;
  }

  // --- Bisection fallback on [-0.9999, 100.0] ---
  let lo = -0.9999;
  let hi = 100.0;
  let fLo = npv(lo, flows, asOf);
  const fHi = npv(hi, flows, asOf);
  if (Number.isNaN(fLo) || Number.isNaN(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2.0;
    const fMid = npv(mid, flows, asOf);
    if (Math.abs(fMid) < tol || hi - lo < tol) return new Decimal(mid);
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return new Decimal((lo + hi) / 2.0);
}

// -----------------------------------------------------------------------------
// CAGR
// -----------------------------------------------------------------------------

export function cagr(startValue: Decimal, endValue: Decimal, days: number): Decimal | null {
  if (startValue.lessThanOrEqualTo(0) || endValue.lessThan(0) || days <= 0) return null;
  if (endValue.isZero()) return new Decimal(-1);
  const years = new Decimal(days).dividedBy(DAYS_PER_CALENDAR_YEAR);
  const ratio = endValue.dividedBy(startValue).toNumber();
  const exponent = new Decimal(1).dividedBy(years).toNumber();
  return new Decimal(ratio ** exponent).minus(1);
}

// -----------------------------------------------------------------------------
// Annualise a cumulative return over `days` calendar days
// -----------------------------------------------------------------------------

export function annualizeReturn(totalReturn: Decimal, days: number): Decimal | null {
  if (days <= 0) return null;
  const base = new Decimal(1).plus(totalReturn);
  if (base.lessThanOrEqualTo(0)) return null;
  const exponent = DAYS_PER_YEAR.dividedBy(days).toNumber();
  return new Decimal(base.toNumber() ** exponent).minus(1);
}

// -----------------------------------------------------------------------------
// Simple growth variants
// -----------------------------------------------------------------------------

export function totalGrowthPct(contributions: Decimal, currentValue: Decimal): Decimal | null {
  if (contributions.isZero()) return null;
  return currentValue.minus(contributions).dividedBy(contributions);
}

export function capitalGain(
  contributions: Decimal,
  currentValue: Decimal,
  cumulativeDividendsCash: Decimal = new Decimal(0),
): Decimal {
  return currentValue.plus(cumulativeDividendsCash).minus(contributions);
}

// -----------------------------------------------------------------------------
// Total Growth (compounded XIRR)
// -----------------------------------------------------------------------------

export function yearsBetween(start: string, end: string): Decimal {
  const days = daysBetween(start, end);
  if (days <= 0) return new Decimal(0);
  return new Decimal(days).dividedBy(DAYS_PER_CALENDAR_YEAR);
}

export function totalGrowthPctCompounded(
  xirrRate: Decimal | null,
  years: Decimal,
): Decimal | null {
  if (xirrRate === null || years.lessThanOrEqualTo(0)) return null;
  const base = new Decimal(1).plus(xirrRate);
  if (base.lessThanOrEqualTo(0)) return null;
  const grown = base.toNumber() ** years.toNumber();
  if (Number.isNaN(grown) || !Number.isFinite(grown)) return null;
  return new Decimal(grown).minus(1);
}
