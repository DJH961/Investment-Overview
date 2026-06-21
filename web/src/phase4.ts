/**
 * Phase 4 compute layer — periods, analytics display, deposits and the forward
 * projection calculator (proposal §9 Phase 4).
 *
 * Two kinds of data come together here:
 *   - **As-of-export read-models** (`monthly`, `yearly`, `analytics`,
 *     `deposits`) computed on the desktop against full price history and shown
 *     with an "as of export" stamp — they are *not* recomputed live.
 *   - **The current period, recomputed live** (proposal §3.C): the latest
 *     month/year row is overlaid with the browser's live closing value and
 *     growth so today's movement is reflected, while completed prior periods
 *     stay frozen exactly as exported.
 *
 * The projection mirrors `ui/pages/_projection_query.project` (an ordinary
 * annuity: grow by the scenario rate, then add the contribution at period end)
 * so the web calculator agrees with the desktop one.
 */

import { Decimal } from "./decimal-config";
import type { OverviewView } from "./compute";
import type {
  ExportAnalytics,
  ExportAttributionRow,
  ExportDepositRecord,
  ExportDeposits,
  ExportEquityPoint,
  ExportPeriodRow,
  MobileExport,
} from "./types";

/** A period row ready to render; current period may be a live overlay. */
export interface PeriodRowView {
  label: string;
  netFlowEur: Decimal;
  contributionsEur: Decimal;
  dividendsEur: Decimal;
  interestEur: Decimal;
  openingValueEur: Decimal;
  closingValueEur: Decimal | null;
  growthPct: Decimal | null;
  /** True for the current (still-open) month/year. */
  isCurrent: boolean;
  /** True when the growth/closing value was recomputed live in the browser. */
  isLive: boolean;
}

export interface PeriodsView {
  monthly: PeriodRowView[];
  yearly: PeriodRowView[];
}

export interface RiskMetric {
  label: string;
  value: Decimal | null;
  /** How to format: ratio→percent, plain number, or money. */
  kind: "pct" | "num" | "money";
}

export interface EquityPoint {
  date: string;
  portfolioValue: Decimal | null;
  contributions: Decimal | null;
  benchmarkValue: Decimal | null;
}

export interface AttributionRowView {
  symbol: string;
  absolutePnlEur: Decimal | null;
  pctOfTotalReturn: Decimal | null;
}

export interface AnalyticsView {
  asOf: string;
  start: string;
  currency: string;
  benchmarkSymbol: string | null;
  riskFreeSymbol: string | null;
  returns: RiskMetric[];
  risk: RiskMetric[];
  curve: EquityPoint[];
  attribution: AttributionRowView[];
}

export interface DepositRowView {
  date: string;
  account: string;
  kind: string;
  amountEur: Decimal | null;
  currency: string;
  description: string | null;
}

export interface DepositsView {
  totalEur: Decimal | null;
  ytdEur: Decimal | null;
  mtdEur: Decimal | null;
  rows: DepositRowView[];
}

/** Inputs for the forward-projection calculator. */
export interface PlanView {
  startingValueEur: Decimal;
  /** Average historical yearly contribution (EUR), the default the form seeds. */
  defaultAnnualContributionEur: Decimal;
}

function dec(value: string | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : new Decimal(value);
}

function decOr0(value: string | null | undefined): Decimal {
  return dec(value) ?? new Decimal(0);
}

function mapPeriodRow(row: ExportPeriodRow): PeriodRowView {
  return {
    label: row.label,
    netFlowEur: decOr0(row.net_flow_eur),
    contributionsEur: decOr0(row.contributions_eur),
    dividendsEur: decOr0(row.dividends_eur),
    interestEur: decOr0(row.interest_eur),
    openingValueEur: decOr0(row.opening_value_eur),
    closingValueEur: dec(row.closing_value_eur),
    growthPct: dec(row.growth_pct),
    isCurrent: false,
    isLive: false,
  };
}

/**
 * Overlay the live current-period figures onto the matching (latest) row. The
 * current month label is `YYYY-MM`, the current year `YYYY` (matching the
 * desktop `_period_query` bucket labels), so we key off `meta.as_of`.
 */
function overlayCurrent(
  rows: PeriodRowView[],
  currentLabel: string,
  liveGrowthPct: Decimal | null,
  liveClosingEur: Decimal,
): void {
  for (const row of rows) {
    if (row.label !== currentLabel) continue;
    row.isCurrent = true;
    row.closingValueEur = liveClosingEur;
    if (liveGrowthPct !== null) {
      row.growthPct = liveGrowthPct;
      row.isLive = true;
    }
  }
}

/** Build the monthly + yearly period tables, overlaying the live current period. */
export function buildPeriods(data: MobileExport, overview: OverviewView): PeriodsView {
  const monthly = (data.monthly?.rows ?? []).map(mapPeriodRow);
  const yearly = (data.yearly?.rows ?? []).map(mapPeriodRow);
  const anchor = data.meta.as_of || overview.asOf;
  overlayCurrent(monthly, anchor.slice(0, 7), overview.mtdGrowthPct, overview.totalValueEur);
  overlayCurrent(yearly, anchor.slice(0, 4), overview.ytdGrowthPct, overview.totalValueEur);
  // Newest period first (neobroker reverse-chronological list).
  monthly.reverse();
  yearly.reverse();
  return { monthly, yearly };
}

function mapEquityPoint(p: ExportEquityPoint): EquityPoint {
  return {
    date: p.date,
    portfolioValue: dec(p.portfolio_value),
    contributions: dec(p.cumulative_contributions),
    benchmarkValue: dec(p.benchmark_value),
  };
}

function mapAttribution(r: ExportAttributionRow): AttributionRowView {
  return {
    symbol: r.symbol,
    absolutePnlEur: dec(r.absolute_pnl),
    pctOfTotalReturn: dec(r.pct_of_total_return),
  };
}

/** Build the (display-only) analytics / risk view from the exported bundle. */
export function buildAnalytics(data: MobileExport): AnalyticsView | null {
  const a: ExportAnalytics | undefined = data.analytics;
  if (!a) return null;
  const returns: RiskMetric[] = [
    { label: "CAGR", value: dec(a.cagr), kind: "pct" },
    { label: "TWR", value: dec(a.twr), kind: "pct" },
    { label: "XIRR", value: dec(a.xirr), kind: "pct" },
    { label: "Alpha", value: dec(a.alpha), kind: "pct" },
    { label: "Beta", value: dec(a.beta), kind: "num" },
    { label: "Risk-free", value: dec(a.risk_free_rate), kind: "pct" },
  ];
  const risk: RiskMetric[] = [
    { label: "Volatility", value: dec(a.volatility), kind: "pct" },
    { label: "Sharpe", value: dec(a.sharpe), kind: "num" },
    { label: "Sortino", value: dec(a.sortino), kind: "num" },
    { label: "Max drawdown", value: dec(a.max_drawdown), kind: "pct" },
    { label: "Calmar", value: dec(a.calmar), kind: "num" },
    { label: "Ulcer index", value: dec(a.ulcer), kind: "num" },
    { label: "VaR 95%", value: dec(a.var_95), kind: "pct" },
    { label: "CVaR 95%", value: dec(a.cvar_95), kind: "pct" },
    { label: "Skew", value: dec(a.skew), kind: "num" },
    { label: "Kurtosis", value: dec(a.kurtosis), kind: "num" },
  ];
  return {
    asOf: a.as_of,
    start: a.start,
    currency: a.currency,
    benchmarkSymbol: a.benchmark_symbol,
    riskFreeSymbol: a.risk_free_symbol,
    returns,
    risk,
    curve: (a.curve ?? []).map(mapEquityPoint),
    attribution: (a.attribution ?? [])
      .map(mapAttribution)
      .sort((x, y) => (y.absolutePnlEur?.toNumber() ?? 0) - (x.absolutePnlEur?.toNumber() ?? 0)),
  };
}

function mapDepositRecord(r: ExportDepositRecord): DepositRowView {
  return {
    date: r.date,
    account: r.account,
    kind: r.kind,
    amountEur: dec(r.amount_eur),
    currency: r.currency,
    description: r.description,
  };
}

/** Build the deposits/contributions view from the exported read-model. */
export function buildDeposits(data: MobileExport): DepositsView | null {
  const d: ExportDeposits | undefined = data.deposits;
  if (!d) return null;
  const rows = (d.rows ?? [])
    .map(mapDepositRecord)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    totalEur: dec(d.summary?.total_contrib_eur),
    ytdEur: dec(d.summary?.ytd_contrib_eur),
    mtdEur: dec(d.summary?.mtd_contrib_eur),
    rows,
  };
}

/**
 * Average historical yearly contribution (positive years only), mirroring
 * `_projection_query._avg_yearly_contribution`. Falls back to deriving it from
 * the portfolio cashflows when no yearly read-model is present.
 */
function averageYearlyContribution(data: MobileExport): Decimal {
  const rows = data.yearly?.rows ?? [];
  const positives = rows
    .map((r) => decOr0(r.contributions_eur))
    .filter((v) => v.greaterThan(0));
  if (positives.length > 0) {
    const sum = positives.reduce((acc, v) => acc.plus(v), new Decimal(0));
    return sum.dividedBy(positives.length);
  }
  // Fallback: sum exported contributions (deposits are negative in XIRR
  // convention) and divide by the number of distinct years they span.
  const years = new Set<string>();
  let total = new Decimal(0);
  for (const cf of data.portfolio_cashflows) {
    const amount = new Decimal(cf.amount);
    if (amount.lessThan(0)) {
      total = total.plus(amount.negated());
      years.add(cf.date.slice(0, 4));
    }
  }
  return years.size > 0 ? total.dividedBy(years.size) : new Decimal(0);
}

/** Build the projection calculator inputs from the live total + history. */
export function buildPlan(data: MobileExport, overview: OverviewView): PlanView {
  return {
    startingValueEur: overview.totalValueEur,
    defaultAnnualContributionEur: averageYearlyContribution(data),
  };
}

/** Default annual-return scenarios (conservative / moderate / optimistic). */
export const PROJECTION_SCENARIOS: readonly string[] = ["0.04", "0.07", "0.10"] as const;

export interface ProjectionRow {
  year: number;
  contributedEur: Decimal;
  valuesByRate: Map<string, Decimal>;
}

/**
 * Forward-project `years` years from `startingValue`, mirroring the Python
 * `project`: each year grows by the scenario rate, then receives the annual
 * contribution at year-end (an ordinary annuity).
 */
export function projectForward(
  startingValueEur: Decimal,
  annualContributionEur: Decimal,
  years: number,
  baseYear: number,
  scenarios: readonly string[] = PROJECTION_SCENARIOS,
): ProjectionRow[] {
  const rates = scenarios.map((s) => new Decimal(s));
  const values = new Map<string, Decimal>(scenarios.map((s) => [s, startingValueEur]));
  let cumulative = new Decimal(0);
  const out: ProjectionRow[] = [];
  for (let offset = 1; offset <= years; offset += 1) {
    cumulative = cumulative.plus(annualContributionEur);
    for (let i = 0; i < scenarios.length; i += 1) {
      const key = scenarios[i];
      const grown = values.get(key)!.times(new Decimal(1).plus(rates[i])).plus(annualContributionEur);
      values.set(key, grown);
    }
    out.push({
      year: baseYear + offset,
      contributedEur: cumulative,
      valuesByRate: new Map(values),
    });
  }
  return out;
}
