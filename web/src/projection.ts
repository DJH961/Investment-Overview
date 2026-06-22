/**
 * Portfolio projection engine — faithful TS port of _projection_model.py (v2.3).
 *
 * Pure math (no DOM). All monetary values are currency-agnostic (EUR base).
 * Mirrors the Python original exactly: ordinary annuity (grow then add
 * contribution at period end), geometric per-period rate, annual step-up, and
 * an inflation deflator that produces a "real" (today's money) twin for every
 * nominal scenario.
 */

import { Decimal } from "./decimal-config";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

export const FALLBACK_EXPECTED_RATE = new Decimal("0.07");
const MIN_REASONABLE_RATE = new Decimal("-0.50");
const MAX_REASONABLE_RATE = new Decimal("0.40");

export const SCENARIO_EXPECTED = "expected";
export const SCENARIO_OPTIMISTIC = "optimistic";
export const SCENARIO_PESSIMISTIC = "pessimistic";
export const SCENARIO_NAMES: readonly string[] = [
  SCENARIO_PESSIMISTIC,
  SCENARIO_EXPECTED,
  SCENARIO_OPTIMISTIC,
] as const;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** All assumptions for one simulation run (currency-agnostic, EUR base). */
export interface ProjectionParams {
  startingValue: Decimal;
  /** Per-period base contribution (pre step-up). */
  baseContribution: Decimal;
  /** Total number of periods to simulate. */
  periods: number;
  /** 12 for monthly view, 1 for yearly view. */
  periodsPerYear: number;
  /** Map from scenario name to annual growth rate. */
  annualRates: Record<string, Decimal>;
  /** Optional annual step-up of the contribution (default 0). */
  annualContributionGrowth?: Decimal;
  /** Optional annual inflation rate for the real twin (default 0). */
  inflationRate?: Decimal;
  /** Simulation start date (defaults to today). */
  start?: Date | null;
}

/** One simulated period. */
export interface ProjectionPoint {
  /** 1-based period offset from the start date. */
  index: number;
  /** "YYYY-MM" for monthly, "YYYY" for yearly. */
  label: string;
  /** Representative date for the period. */
  periodDate: Date;
  /** Cumulative new money contributed up to and including this period. */
  contributed: Decimal;
  /** Nominal (future) values by scenario name. */
  nominalByScenario: Record<string, Decimal>;
  /** Inflation-adjusted (today's-money) values by scenario name. */
  realByScenario: Record<string, Decimal>;
}

/** When a scenario first reaches a target value. */
export interface TargetHit {
  scenario: string;
  label: string;
  index: number;
  years: Decimal;
}

/** Full simulation output. */
export interface ProjectionResult {
  params: ProjectionParams;
  points: ProjectionPoint[];
}

// ---------------------------------------------------------------------------
// Convenience accessors (mirror the Python dataclass properties)
// ---------------------------------------------------------------------------

export function finalPoint(result: ProjectionResult): ProjectionPoint | null {
  return result.points.length > 0 ? result.points[result.points.length - 1] : null;
}

export function finalNominal(result: ProjectionResult, scenario: string): Decimal {
  const last = finalPoint(result);
  return last !== null ? last.nominalByScenario[scenario] : result.params.startingValue;
}

export function totalContributed(result: ProjectionResult): Decimal {
  const last = finalPoint(result);
  return last !== null ? last.contributed : ZERO;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Per-period equivalent of `annualRate` (geometric, not naive /n).
 * Mirrors Python's `_per_period_rate`.
 */
function _perPeriodRate(annualRate: Decimal, periodsPerYear: number): Decimal {
  if (periodsPerYear <= 1) return annualRate;
  const base = ONE.plus(annualRate);
  if (base.lessThanOrEqualTo(0)) return new Decimal("-1");
  return new Decimal(Math.pow(base.toNumber(), 1.0 / periodsPerYear)).minus(ONE);
}

/**
 * Label and representative date for the `index`-th period after `start`.
 * Mirrors Python's `_advance_label`.
 */
function _advanceLabel(
  start: Date,
  index: number,
  periodsPerYear: number,
): { label: string; periodDate: Date } {
  if (periodsPerYear >= 12) {
    const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + index;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const label = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    return { label, periodDate: new Date(Date.UTC(year, month - 1, 1)) };
  }
  const year = start.getUTCFullYear() + index;
  return {
    label: String(year).padStart(4, "0"),
    periodDate: new Date(Date.UTC(year, 11, 31)),
  };
}

/**
 * Contribution in period `index` after applying the annual step-up.
 * Mirrors Python's `_contribution_for_period`.
 */
function _contributionForPeriod(
  base: Decimal,
  index: number,
  periodsPerYear: number,
  annualGrowth: Decimal,
): Decimal {
  if (annualGrowth.isZero()) return base;
  const yearIndex = Math.floor((index - 1) / periodsPerYear);
  return base.times(ONE.plus(annualGrowth).pow(yearIndex));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clamp an arbitrary (possibly null / extreme) rate into a sane band.
 * Mirrors Python's `sanitize_rate`.
 */
export function sanitizeRate(rate: Decimal | null): Decimal {
  if (rate === null) return FALLBACK_EXPECTED_RATE;
  if (rate.lessThan(MIN_REASONABLE_RATE)) return MIN_REASONABLE_RATE;
  if (rate.greaterThan(MAX_REASONABLE_RATE)) return MAX_REASONABLE_RATE;
  return rate;
}

/**
 * Pick the default expected return: the portfolio's XIRR, sanitised.
 * Mirrors Python's `default_expected_rate`.
 */
export function defaultExpectedRate(xirr: Decimal | null): Decimal {
  if (xirr === null) return FALLBACK_EXPECTED_RATE;
  return sanitizeRate(xirr);
}

/**
 * Expected ± `band` annual percentage points (pessimistic floored at -0.99).
 * Mirrors Python's `band_rates`.
 */
export function bandRates(expected: Decimal, band: Decimal): Record<string, Decimal> {
  const pessimisticRaw = expected.minus(band);
  const pessimistic = pessimisticRaw.lessThan(new Decimal("-0.99"))
    ? new Decimal("-0.99")
    : pessimisticRaw;
  return {
    [SCENARIO_PESSIMISTIC]: pessimistic,
    [SCENARIO_EXPECTED]: expected,
    [SCENARIO_OPTIMISTIC]: expected.plus(band),
  };
}

/**
 * Run the forward simulation described by `params`.
 *
 * Each period the balance grows by the scenario's per-period rate and then
 * receives that period's (possibly stepped-up) contribution at period end —
 * an ordinary annuity, matching the rest of the app.
 *
 * Mirrors Python's `simulate`.
 */
export function simulate(params: ProjectionParams): ProjectionResult {
  if (params.periods < 0) throw new Error("periods must be non-negative");
  if (params.periodsPerYear < 1) throw new Error("periodsPerYear must be >= 1");

  const annualGrowth = params.annualContributionGrowth ?? ZERO;
  const inflationRate = params.inflationRate ?? ZERO;
  const start = params.start ?? new Date();

  // Pre-compute per-period rate for each scenario.
  const perPeriod: Record<string, Decimal> = {};
  for (const [name, rate] of Object.entries(params.annualRates)) {
    perPeriod[name] = _perPeriodRate(rate, params.periodsPerYear);
  }

  // Running balances, one per scenario.
  const values: Record<string, Decimal> = {};
  for (const name of Object.keys(params.annualRates)) {
    values[name] = params.startingValue;
  }

  let cumulative = ZERO;
  const points: ProjectionPoint[] = [];

  for (let index = 1; index <= params.periods; index++) {
    const contrib = _contributionForPeriod(
      params.baseContribution,
      index,
      params.periodsPerYear,
      annualGrowth,
    );
    cumulative = cumulative.plus(contrib);

    for (const name of Object.keys(params.annualRates)) {
      values[name] = values[name].times(ONE.plus(perPeriod[name])).plus(contrib);
    }

    // Inflation deflator to convert nominal → real (today's purchasing power).
    const yearsElapsed = new Decimal(index).dividedBy(params.periodsPerYear);
    const deflator = ONE.plus(inflationRate).pow(yearsElapsed);

    const { label, periodDate } = _advanceLabel(start, index, params.periodsPerYear);
    const nominal: Record<string, Decimal> = { ...values };
    const real: Record<string, Decimal> = {};
    for (const [name, v] of Object.entries(nominal)) {
      real[name] = deflator.isZero() ? v : v.dividedBy(deflator);
    }

    points.push({
      index,
      label,
      periodDate,
      contributed: cumulative,
      nominalByScenario: nominal,
      realByScenario: real,
    });
  }

  return { params, points };
}

/**
 * First period in which each scenario reaches `target` (or `null`).
 * When `real` is true the comparison uses inflation-adjusted values.
 * Mirrors Python's `time_to_target`.
 */
export function timeToTarget(
  result: ProjectionResult,
  target: Decimal,
  {
    scenarios = SCENARIO_NAMES,
    real = false,
  }: { scenarios?: readonly string[]; real?: boolean } = {},
): Record<string, TargetHit | null> {
  const out: Record<string, TargetHit | null> = {};
  for (const s of scenarios) out[s] = null;
  if (target.lessThanOrEqualTo(0)) return out;

  for (const point of result.points) {
    const series = real ? point.realByScenario : point.nominalByScenario;
    for (const scenario of scenarios) {
      if (out[scenario] === null) {
        const v = series[scenario] ?? ZERO;
        if (v.greaterThanOrEqualTo(target)) {
          out[scenario] = {
            scenario,
            label: point.label,
            index: point.index,
            years: new Decimal(point.index).dividedBy(result.params.periodsPerYear),
          };
        }
      }
    }
  }
  return out;
}

/** Final expected value when the per-period base contribution is `base`. */
function _finalValueForContribution(
  params: ProjectionParams,
  base: Decimal,
  scenario: string,
): Decimal {
  const trial: ProjectionParams = {
    startingValue: params.startingValue,
    baseContribution: base,
    periods: params.periods,
    periodsPerYear: params.periodsPerYear,
    annualRates: { [scenario]: params.annualRates[scenario] },
    annualContributionGrowth: params.annualContributionGrowth ?? ZERO,
    inflationRate: params.inflationRate ?? ZERO,
    start: params.start,
  };
  return finalNominal(simulate(trial), scenario);
}

/**
 * Per-period contribution needed to reach `target` by the horizon.
 *
 * Solved by bisection on the (monotonic-in-contribution) final value.
 * Returns ZERO when the target is already met with no new money, and null
 * when even a very large contribution cannot reach it within the horizon
 * (e.g. horizon of zero periods).
 * Mirrors Python's `required_contribution`.
 */
export function requiredContribution(
  params: ProjectionParams,
  target: Decimal,
  {
    scenario = SCENARIO_EXPECTED,
    maxIter = 60,
  }: { scenario?: string; maxIter?: number } = {},
): Decimal | null {
  if (params.periods <= 0 || target.lessThanOrEqualTo(0)) return null;
  if (_finalValueForContribution(params, ZERO, scenario).greaterThanOrEqualTo(target)) {
    return ZERO;
  }

  let lo = ZERO;
  let hi = Decimal.max(target, new Decimal("1"));

  // Expand the upper bound until it overshoots the target.
  let found = false;
  for (let i = 0; i < 40; i++) {
    if (_finalValueForContribution(params, hi, scenario).greaterThanOrEqualTo(target)) {
      found = true;
      break;
    }
    hi = hi.times(2);
  }
  if (!found) return null;

  // Bisection refinement.
  for (let i = 0; i < maxIter; i++) {
    const mid = lo.plus(hi).dividedBy(2);
    if (_finalValueForContribution(params, mid, scenario).greaterThanOrEqualTo(target)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}
