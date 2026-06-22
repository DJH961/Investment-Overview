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
import { defaultExpectedRate, sanitizeRate } from "./projection";
import type {
  DecimalString,
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
  /**
   * Period growth recomputed against per-trade-date USD figures (the export's
   * `growth_pct_display` when the row is built against a USD context, or the
   * live USD MTD/YTD growth for the current period). Lets the periods list
   * respond to the currency toggle just like the per-stock and headline growth.
   * Null when no USD figure is available, in which case the EUR growth is shown.
   */
  growthPctUsd: Decimal | null;
  /**
   * Per-trade-date FX USD figures from the export (null when FX history is too
   * sparse, or for live-recomputed current-period overlays). Used so USD
   * readers see the contributions/flows their wallet actually moved rather than
   * the EUR figure rescaled by today's spot.
   */
  netFlowUsd: Decimal | null;
  contributionsUsd: Decimal | null;
  dividendsUsd: Decimal | null;
  interestUsd: Decimal | null;
  closingValueUsd: Decimal | null;
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
  /**
   * USD companion of the metric (computed on the USD-denominated equity curve
   * in the export). Preferred when USD is the display currency so the Risk tab
   * tracks the currency toggle. Null when the export didn't carry it (older
   * exports) or the metric isn't currency-sensitive (e.g. the risk-free rate).
   */
  valueUsd: Decimal | null;
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
  /** USD value of this cash flow on its own trade date (per-date FX). */
  amountUsd: Decimal | null;
  currency: string;
  description: string | null;
}

export interface DepositsView {
  totalEur: Decimal | null;
  ytdEur: Decimal | null;
  mtdEur: Decimal | null;
  /** Per-date-FX USD contribution KPIs (null when FX history is unavailable). */
  totalUsd: Decimal | null;
  ytdUsd: Decimal | null;
  mtdUsd: Decimal | null;
  rows: DepositRowView[];
}

/** Inputs for the forward-projection calculator. */
export interface PlanView {
  startingValueEur: Decimal;
  /** Average historical yearly contribution (EUR), the default the form seeds. */
  defaultAnnualContributionEur: Decimal;
  /** Average historical monthly contribution (EUR), seed for the monthly view. */
  defaultMonthlyContributionEur: Decimal;
  /** Valuation year the projection counts forward from (anchored to `as_of`). */
  baseYear: number;
  /**
   * Seeded expected annual return rate for EUR (from the portfolio's XIRR,
   * sanitised through defaultExpectedRate / sanitizeRate). Falls back to
   * FALLBACK_EXPECTED_RATE when no XIRR is available.
   */
  expectedRateEur: Decimal;
  /**
   * USD companion of expectedRateEur. Null when no USD XIRR is available.
   */
  expectedRateUsd: Decimal | null;
}

function dec(value: string | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : new Decimal(value);
}

function decOr0(value: string | null | undefined): Decimal {
  return dec(value) ?? new Decimal(0);
}

/**
 * Modified Dietz period return, mirroring the desktop `_modified_dietz`:
 * `(close - open - flow) / (open + flow/2)`. Used as a web-side *fallback* when
 * the export left a completed period's growth undefined — most often the very
 * first period, which opens at 0 yet still has a meaningful return on the money
 * paid in that period. `flow` is the external contributions only (dividends and
 * interest are internal gains). Returns null when the denominator is
 * non-positive (e.g. a period with no opening value and no contributions).
 */
function modifiedDietzGrowth(
  opening: Decimal,
  closing: Decimal,
  contributions: Decimal,
): Decimal | null {
  const denom = opening.plus(contributions.dividedBy(2));
  if (denom.lessThanOrEqualTo(0)) return null;
  return closing.minus(opening).minus(contributions).dividedBy(denom);
}

function mapPeriodRow(row: ExportPeriodRow): PeriodRowView {
  const openingValueEur = decOr0(row.opening_value_eur);
  const closingValueEur = dec(row.closing_value_eur);
  const contributionsEur = decOr0(row.contributions_eur);
  // Prefer the exported (chained-TWR) growth; when it is missing but we have a
  // closing value, fall back to a Modified Dietz so periods like the first year
  // (which opens at 0) still show a growth number instead of a bare dash.
  let growthPct = dec(row.growth_pct);
  if (growthPct === null && closingValueEur !== null) {
    growthPct = modifiedDietzGrowth(openingValueEur, closingValueEur, contributionsEur);
  }
  // The mobile export builds period read-models against a USD context, so the
  // `*_display` fields are per-trade-date USD. Only trust them when the row
  // actually says so; otherwise leave null and let the formatter fall back.
  const usd = (row.display_currency ?? "").toUpperCase() === "USD";
  return {
    label: row.label,
    netFlowEur: decOr0(row.net_flow_eur),
    contributionsEur,
    dividendsEur: decOr0(row.dividends_eur),
    interestEur: decOr0(row.interest_eur),
    openingValueEur,
    closingValueEur,
    growthPct,
    growthPctUsd: usd ? dec(row.growth_pct_display) : null,
    netFlowUsd: usd ? dec(row.net_flow_display) : null,
    contributionsUsd: usd ? dec(row.contributions_display) : null,
    dividendsUsd: usd ? dec(row.dividends_display) : null,
    interestUsd: usd ? dec(row.interest_display) : null,
    closingValueUsd: usd ? dec(row.closing_value_display) : null,
    isCurrent: false,
    isLive: false,
  };
}

/**
 * Reflect the live current period in the table. The current month label is
 * `YYYY-MM`, the current year `YYYY` (matching the desktop `_period_query`
 * bucket labels), so we key off `meta.as_of`. When the export already has a row
 * for the current period we overlay the live figures onto it; when it does not
 * (e.g. a brand-new month with no transactions yet) we append a synthetic row
 * so the current period is always present in the overview.
 */
function upsertCurrent(
  rows: PeriodRowView[],
  currentLabel: string,
  liveGrowthPct: Decimal | null,
  liveGrowthPctUsd: Decimal | null,
  liveClosingEur: Decimal,
  live: boolean,
): void {
  const existing = rows.find((row) => row.label === currentLabel);
  if (existing) {
    existing.isCurrent = true;
    existing.closingValueEur = liveClosingEur;
    // Live close is recomputed in EUR; drop the frozen USD close so the
    // formatter spot-converts the live value (correct for a *current* value).
    existing.closingValueUsd = null;
    if (liveGrowthPct !== null) {
      existing.growthPct = liveGrowthPct;
      existing.growthPctUsd = liveGrowthPctUsd;
      // Only flag the row "live" when prices are genuinely live right now (the
      // session is open and the freshest mark is from today). Otherwise the
      // value still updates to the latest close — it just isn't badged "live".
      existing.isLive = live;
    }
    return;
  }
  // No exported bucket for the current period yet: synthesise a live-only row.
  // It sorts last chronologically, so after the reverse() it leads the list.
  // Carry the previous period's close forward as the opening value so the row
  // is continuous with the completed history rather than starting from zero.
  const previousClosing = rows.length > 0 ? rows[rows.length - 1].closingValueEur : null;
  rows.push({
    label: currentLabel,
    netFlowEur: new Decimal(0),
    contributionsEur: new Decimal(0),
    dividendsEur: new Decimal(0),
    interestEur: new Decimal(0),
    openingValueEur: previousClosing ?? new Decimal(0),
    closingValueEur: liveClosingEur,
    growthPct: liveGrowthPct,
    growthPctUsd: liveGrowthPctUsd,
    netFlowUsd: null,
    contributionsUsd: null,
    dividendsUsd: null,
    interestUsd: null,
    closingValueUsd: null,
    isCurrent: true,
    isLive: live && liveGrowthPct !== null,
  });
}

/** Build the monthly + yearly period tables, overlaying the live current period. */
export function buildPeriods(data: MobileExport, overview: OverviewView): PeriodsView {
  const monthlySource = data.monthly?.rows;
  const yearlySource = data.yearly?.rows;
  const monthly = (monthlySource ?? []).map(mapPeriodRow);
  const yearly = (yearlySource ?? []).map(mapPeriodRow);
  const anchor = data.meta.as_of || overview.asOf;
  // Only surface a current period when the export actually carries that table;
  // with no period read-model at all we leave the tables empty.
  if (monthlySource) {
    upsertCurrent(
      monthly,
      anchor.slice(0, 7),
      overview.mtdGrowthPct,
      overview.mtdGrowthPctUsd,
      overview.totalValueEur,
      overview.pricesAreLive,
    );
  }
  if (yearlySource) {
    upsertCurrent(
      yearly,
      anchor.slice(0, 4),
      overview.ytdGrowthPct,
      overview.ytdGrowthPctUsd,
      overview.totalValueEur,
      overview.pricesAreLive,
    );
  }
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
  const m = (
    label: string,
    value: DecimalString | null | undefined,
    valueUsd: DecimalString | null | undefined,
    kind: RiskMetric["kind"],
  ): RiskMetric => ({ label, value: dec(value), valueUsd: dec(valueUsd), kind });
  const returns: RiskMetric[] = [
    m("CAGR", a.cagr, a.cagr_usd, "pct"),
    m("TWR", a.twr, a.twr_usd, "pct"),
    m("XIRR", a.xirr, a.xirr_usd, "pct"),
    m("Alpha", a.alpha, a.alpha_usd, "pct"),
    m("Beta", a.beta, a.beta_usd, "num"),
    // The risk-free rate is a market input, not a portfolio return, so it has
    // no per-currency companion — it reads the same regardless of display.
    m("Risk-free", a.risk_free_rate, null, "pct"),
  ];
  const risk: RiskMetric[] = [
    m("Volatility", a.volatility, a.volatility_usd, "pct"),
    m("Sharpe", a.sharpe, a.sharpe_usd, "num"),
    m("Sortino", a.sortino, a.sortino_usd, "num"),
    m("Max drawdown", a.max_drawdown, a.max_drawdown_usd, "pct"),
    m("Calmar", a.calmar, a.calmar_usd, "num"),
    m("Ulcer index", a.ulcer, a.ulcer_usd, "num"),
    m("VaR 95%", a.var_95, a.var_95_usd, "pct"),
    m("CVaR 95%", a.cvar_95, a.cvar_95_usd, "pct"),
    m("Skew", a.skew, a.skew_usd, "num"),
    m("Kurtosis", a.kurtosis, a.kurtosis_usd, "num"),
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
    amountUsd: dec(r.amount_usd),
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
    totalUsd: dec(d.summary?.total_contrib_usd),
    ytdUsd: dec(d.summary?.ytd_contrib_usd),
    mtdUsd: dec(d.summary?.mtd_contrib_usd),
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

/**
 * Average historical monthly contribution (positive months only), mirroring
 * `averageYearlyContribution` but dividing by the number of distinct YYYY-MM
 * months. Falls back to the yearly average / 12 when no monthly read-model
 * is present.
 */
function averageMonthlyContribution(data: MobileExport): Decimal {
  const rows = data.monthly?.rows ?? [];
  const positives = rows
    .map((r) => decOr0(r.contributions_eur))
    .filter((v) => v.greaterThan(0));
  if (positives.length > 0) {
    const sum = positives.reduce((acc, v) => acc.plus(v), new Decimal(0));
    return sum.dividedBy(positives.length);
  }
  // Fallback: derive from cashflows by distinct YYYY-MM months.
  const months = new Set<string>();
  let total = new Decimal(0);
  for (const cf of data.portfolio_cashflows) {
    const amount = new Decimal(cf.amount);
    if (amount.lessThan(0)) {
      total = total.plus(amount.negated());
      months.add(cf.date.slice(0, 7));
    }
  }
  if (months.size > 0) return total.dividedBy(months.size);
  // Last resort: yearly average / 12.
  return averageYearlyContribution(data).dividedBy(12);
}

/** Build the projection calculator inputs from the live total + history. */
export function buildPlan(data: MobileExport, overview: OverviewView): PlanView {
  // Anchor the projection's first year to the valuation date (`as_of`), matching
  // the desktop `project_from_session` (which counts from the context year) and
  // keeping the live recompute and the projection on the same calendar.
  const anchor = data.meta.as_of || overview.asOf;
  const baseYear = Number(anchor.slice(0, 4)) || new Date().getUTCFullYear();

  // Seed the expected annual return rates from the portfolio's XIRR, sanitised
  // to a safe planning range. Falls back to FALLBACK_EXPECTED_RATE when no XIRR
  // is available (new portfolio, all-same-sign cashflows, solver did not converge).
  const expectedRateEur = defaultExpectedRate(overview.portfolioXirr);
  const expectedRateUsd =
    overview.portfolioXirrUsd !== null ? sanitizeRate(overview.portfolioXirrUsd) : null;

  return {
    startingValueEur: overview.totalValueEur,
    defaultAnnualContributionEur: averageYearlyContribution(data),
    defaultMonthlyContributionEur: averageMonthlyContribution(data),
    baseYear,
    expectedRateEur,
    expectedRateUsd,
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

// ---------------------------------------------------------------------------
// Drawdown / underwater series (Feature B)
// ---------------------------------------------------------------------------

/** One point in the drawdown (underwater) curve. */
export interface DrawdownPoint {
  date: string;
  /** (portfolioValue / runningPeak) − 1; always ≤ 0. Null for missing values. */
  drawdown: Decimal | null;
}

/**
 * Compute the running-peak drawdown series from an equity curve.
 *
 * For each point the running peak is the maximum portfolio value seen up to
 * and including that date. The drawdown is `(value / peak) − 1` and is
 * always ≤ 0 (it is zero at each new peak, negative in troughs).
 *
 * Used by `renderDrawdownChart` on the Risk tab. Pure function — no DOM.
 */
export function computeDrawdownSeries(curve: EquityPoint[]): DrawdownPoint[] {
  let peak: Decimal | null = null;
  return curve.map((p) => {
    if (p.portfolioValue === null) return { date: p.date, drawdown: null };
    // Skip non-positive values to avoid skewing the running peak while
    // the portfolio is still being funded from scratch.
    if (p.portfolioValue.lessThanOrEqualTo(0)) return { date: p.date, drawdown: null };
    if (peak === null || p.portfolioValue.greaterThan(peak)) {
      peak = p.portfolioValue;
    }
    return { date: p.date, drawdown: p.portfolioValue.dividedBy(peak).minus(1) };
  });
}
