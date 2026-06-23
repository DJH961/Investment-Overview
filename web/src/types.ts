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
  /** The same flow converted at its own trade-date EUR→USD rate (USD-native
   * rows use their booked amount). Lets the browser recompute currency-correct
   * USD growth without rescaling at today's spot. Absent on older exports. */
  amount_usd?: DecimalString | null;
}

export interface ExportHolding {
  symbol: string;
  name: string | null;
  asset_class: string;
  /**
   * The holding's category grouping key (Overview/Calculator buckets). `null`
   * when no explicit category was assigned, in which case the calculator falls
   * back to `asset_class` then `"Uncategorized"`, mirroring the desktop. Absent
   * on exports generated before this field was added (treated as `null`). */
  category?: string | null;
  broker: string;
  account: string;
  native_currency: string;
  shares: DecimalString;
  cost_basis_native: DecimalString;
  /** Cost basis converted at each buy's own trade-date EUR→USD rate (not
   * today's spot), for a currency-correct total gain *and growth*. `*_eur` is
   * the EUR the buys actually cost and `*_usd` the USD; deriving the EUR cost
   * basis from today's spot instead made EUR and USD growth collapse to the
   * same number. Absent on older exports, in which case the browser falls back
   * to a spot conversion. */
  cost_basis_eur?: DecimalString | null;
  cost_basis_usd?: DecimalString | null;
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
  /**
   * Whether this row is a money-market / settlement fund (Vanguard `VMFXX`,
   * Fidelity `SPAXX`, …). Such funds hold a constant $1.00 NAV by design, so
   * they are never sent to the price provider (it would only ever return the
   * same dollar and waste a free-tier credit). Absent on older exports, in
   * which case the browser falls back to a ticker/name heuristic. */
  is_money_market?: boolean;
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
  month_start_value_usd?: DecimalString | null;
  year_start_value_usd?: DecimalString | null;
}

export interface PeriodOpenings {
  month_start_value_eur: DecimalString;
  year_start_value_eur: DecimalString;
  month_start_value_usd?: DecimalString | null;
  year_start_value_usd?: DecimalString | null;
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
  /**
   * Per-trade-date FX-converted figures (see `readmodels/periods.py`). The
   * mobile export builds the period read-models against a USD context, so for
   * web exports `display_currency` is `"USD"` and the `*_display` fields carry
   * the USD value each figure had at the rate in force on its own
   * trade/boundary date — not today's spot. Absent/`null` when FX history is
   * too sparse to convert, in which case the browser falls back to EUR.
   */
  display_currency?: string | null;
  contributions_display?: DecimalString | null;
  dividends_display?: DecimalString | null;
  interest_display?: DecimalString | null;
  net_flow_display?: DecimalString | null;
  opening_value_display?: DecimalString | null;
  closing_value_display?: DecimalString | null;
  growth_pct_display?: DecimalString | null;
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
  /**
   * USD companions for the currency-sensitive scalar metrics (computed on the
   * USD-denominated equity curve). Present when the export carries them; the
   * web prefers these when USD is the display currency so the Risk tab responds
   * to the currency toggle. Absent on older exports (the EUR figure is shown).
   */
  cagr_usd?: DecimalString | null;
  twr_usd?: DecimalString | null;
  xirr_usd?: DecimalString | null;
  volatility_usd?: DecimalString | null;
  sharpe_usd?: DecimalString | null;
  sortino_usd?: DecimalString | null;
  max_drawdown_usd?: DecimalString | null;
  calmar_usd?: DecimalString | null;
  ulcer_usd?: DecimalString | null;
  var_95_usd?: DecimalString | null;
  cvar_95_usd?: DecimalString | null;
  skew_usd?: DecimalString | null;
  kurtosis_usd?: DecimalString | null;
  beta_usd?: DecimalString | null;
  alpha_usd?: DecimalString | null;
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
  /**
   * Same contribution KPIs re-aggregated in USD using the EUR→USD rate in
   * force **on each transaction's date** (USD-native deposits use their booked
   * amount). Prefer these over rescaling the EUR totals by today's spot, which
   * double-converts deposits originally booked in USD.
   */
  total_contrib_usd?: DecimalString | null;
  ytd_contrib_usd?: DecimalString | null;
  mtd_contrib_usd?: DecimalString | null;
}

export interface ExportDepositRecord {
  id: number;
  date: string;
  account: string;
  kind: string;
  amount_eur: DecimalString | null;
  /** USD value of this cash flow on its own trade date (per-date FX). */
  amount_usd?: DecimalString | null;
  amount_native?: DecimalString | null;
  currency: string;
  description: string | null;
}

export interface ExportDeposits {
  summary: ExportDepositsSummary;
  rows: ExportDepositRecord[];
}

/** A single fund inside a saved target allocation. */
export interface ExportTargetAllocationItem {
  instrument_id: number;
  symbol: string;
  weight_pct: DecimalString;
  /** Counted toward the target % but never bought with fresh cash (the
   * Calculator's "no-buy" distinction). */
  no_buy: boolean;
}

/** A saved Calculator target allocation, with its no-buy flags and the
 * rebalance/currency settings it was built under. */
export interface ExportTargetAllocation {
  name: string;
  active: boolean;
  /** Rebalance toggle: off = buy-only, on = may sell over-weight funds. */
  allow_sell: boolean;
  /** Entry/display currency the target was built in (`EUR`/`USD`), or null. */
  display_currency: string | null;
  items: ExportTargetAllocationItem[];
}

/**
 * The full export. The as-of-export read-models (`monthly`, `yearly`,
 * `analytics`, `deposits`) are surfaced in Phase 4 (periods, projection and the
 * analytics display); `transactions` remains optional and is carried opaquely.
 */
/**
 * Portfolio-level scalars (from `mobile_export._portfolio_metrics`) that let the
 * browser recompute the desktop's **capital gain** and **trailing dividend
 * yield** against live prices. Absent on exports generated before v3.9.4, so all
 * fields are optional and the web falls back to its value−cost gain / YTD yield.
 */
export interface PortfolioMetrics {
  /** Net external contributions (deposits − withdrawals), EUR / USD. */
  net_contributions_eur?: DecimalString | null;
  net_contributions_usd?: DecimalString | null;
  /** Realized (un-reinvested) cash dividends added back into capital gain. */
  dividends_cash_eur?: DecimalString | null;
  dividends_cash_usd?: DecimalString | null;
  /** Lifetime dividend income incl. reinvested, for the trailing yield. */
  dividends_income_eur?: DecimalString | null;
  dividends_income_usd?: DecimalString | null;
}

export interface MobileExport {
  meta: ExportMeta;
  holdings: ExportHolding[];
  portfolio_cashflows: ExportCashflow[];
  portfolio_metrics?: PortfolioMetrics;
  cash: ExportCash[];
  period_openings: PeriodOpenings;
  monthly?: ExportPeriods;
  yearly?: ExportPeriods;
  analytics?: ExportAnalytics;
  deposits?: ExportDeposits;
  /** Saved Calculator targets with their no-buy flags + settings. Absent on
   * exports generated before v3.5.3. */
  target_allocations?: ExportTargetAllocation[];
  transactions?: unknown;
}
