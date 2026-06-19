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
 * The full export. The as-of-export read-models (`monthly`, `yearly`,
 * `analytics`, `deposits`, `transactions`) are carried opaquely in Phase 3 —
 * their live display lands in Phase 4 — so they are typed loosely here.
 */
export interface MobileExport {
  meta: ExportMeta;
  holdings: ExportHolding[];
  portfolio_cashflows: ExportCashflow[];
  cash: ExportCash[];
  period_openings: PeriodOpenings;
  monthly?: unknown;
  yearly?: unknown;
  analytics?: unknown;
  deposits?: unknown;
  transactions?: unknown;
}
