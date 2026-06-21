/**
 * TypeScript shape of the minimized mobile export contract
 * (`docs/mobile_export_schema.md`, schema_version 1). All decimal values arrive
 * as strings and are parsed with decimal.js where arithmetic is needed.
 */

export type DecimalString = string;
export type PriceType = "market" | "nav";

export interface ExportMeta {
  schema_version: number;
  app_version: string;
  generated_at: string;
  as_of: string;
  display_currency: string;
  fx_pivot: string;
  fx_rate_eur_usd: DecimalString | null;
  currency_note: string;
}

export interface ExportCashflow {
  date: string;
  amount: DecimalString;
}

export interface ExportHolding {
  symbol: string;
  name: string | null;
  asset_class: string;
  broker: string;
  account: string;
  native_currency: string;
  shares: DecimalString;
  cost_basis_native: DecimalString;
  cumulative_dividends_cash_native: DecimalString;
  price_symbol: string;
  price_type: PriceType;
  last_known_price_native: DecimalString | null;
  /**
   * Trading day (`YYYY-MM-DD`) the exported `last_known_price_native` came from
   * — the latest cached close on/before the export date. Lets the UI show when
   * a holding's value was actually last updated (e.g. a fund's last NAV strike)
   * instead of the export date. Null/absent for rows with no price history
   * (older exports, or money-market funds pinned at a constant NAV).
   */
  last_price_date?: string | null;
  cashflows: ExportCashflow[];
}

export interface ExportCash {
  account_label: string;
  broker: string;
  native_currency: string;
  balance_native: DecimalString;
}

export interface PeriodOpeningHolding {
  month_start_value_eur: DecimalString;
  year_start_value_eur: DecimalString;
}

export interface PeriodOpenings {
  month_start_value_eur: DecimalString;
  year_start_value_eur: DecimalString;
  holdings: Record<string, PeriodOpeningHolding>;
}

/**
 * One monthly/yearly period row (from `readmodels/periods.py`). The EUR figures
 * are the source of truth the browser displays; the current period's growth is
 * recomputed live against live prices (proposal §3.C).
 */
export interface ExportPeriodRow {
  label: string;
  contributions_eur: DecimalString;
  dividends_eur: DecimalString;
  interest_eur: DecimalString;
  net_flow_eur: DecimalString;
  opening_value_eur: DecimalString;
  closing_value_eur: DecimalString;
  growth_pct: DecimalString | null;
}

export interface ExportPeriods {
  rows: ExportPeriodRow[];
}

/**
 * As-of-export analytics / risk bundle (from `readmodels/analytics.py`). Every
 * metric may be `null` when history is too sparse to compute it.
 */
export interface ExportAnalytics {
  as_of: string;
  start: string;
  currency: string;
  cagr: DecimalString | null;
  twr: DecimalString | null;
  xirr: DecimalString | null;
  volatility: DecimalString | null;
  sharpe: DecimalString | null;
  sortino: DecimalString | null;
  max_drawdown: DecimalString | null;
  calmar: DecimalString | null;
  ulcer: DecimalString | null;
  var_95: DecimalString | null;
  cvar_95: DecimalString | null;
  skew: DecimalString | null;
  kurtosis: DecimalString | null;
  beta: DecimalString | null;
  alpha: DecimalString | null;
  risk_free_rate: DecimalString | null;
  risk_free_symbol: string | null;
  benchmark_symbol: string | null;
  curve: ExportEquityPoint[];
  attribution: ExportAttributionRow[];
}

export interface ExportEquityPoint {
  date: string;
  portfolio_value: DecimalString | null;
  cumulative_contributions: DecimalString | null;
  benchmark_value: DecimalString | null;
}

export interface ExportAttributionRow {
  instrument_id: number;
  symbol: string;
  start_value: DecimalString | null;
  end_value: DecimalString | null;
  net_contribution: DecimalString | null;
  absolute_pnl: DecimalString | null;
  pct_of_total_return: DecimalString | null;
}

/** Deposits / contributions read-model (from `readmodels/deposits.py`). */
export interface ExportDepositsSummary {
  total_contrib_eur: DecimalString | null;
  ytd_contrib_eur: DecimalString | null;
  mtd_contrib_eur: DecimalString | null;
}

export interface ExportDepositRecord {
  id: number;
  date: string;
  account: string;
  kind: string;
  amount_eur: DecimalString | null;
  currency: string;
  description: string | null;
}

export interface ExportDeposits {
  summary: ExportDepositsSummary;
  rows: ExportDepositRecord[];
}

/**
 * The full export. The as-of-export read-models (`monthly`, `yearly`,
 * `analytics`, `deposits`) are surfaced in Phase 4 (periods, projection and the
 * analytics display); `transactions` remains optional and is carried opaquely.
 */
export interface MobileExport {
  meta: ExportMeta;
  holdings: ExportHolding[];
  portfolio_cashflows: ExportCashflow[];
  cash: ExportCash[];
  period_openings: PeriodOpenings;
  monthly?: ExportPeriods;
  yearly?: ExportPeriods;
  analytics?: ExportAnalytics;
  deposits?: ExportDeposits;
  transactions?: unknown;
}
