/**
 * TypeScript shape of the minimized mobile export contract
 * (`docs/mobile_export_schema.md`, schema_version 2). All decimal values arrive
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
  /**
   * The desktop's "regular investment amount" preference (EUR), so the web
   * companion can seed its own device-local override from the single desktop
   * source of truth instead of silently diverging. Absent/null on older exports
   * (the web then keeps its own default/override). See `investment-amount.ts`.
   */
  investment_amount_eur?: DecimalString | null;
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
   * ISO-8601 timestamp of *when* the exported `last_known_price_native` was last
   * struck on the exchange — the provider's `regularMarketTime` (a market quote's
   * intraday instant, or a fund's NAV publish time). Distinct from
   * `last_price_date` (the value-date): it lets the UI stamp a precise "as of
   * <time>" on a blob-priced row instead of only a date. Null/absent for rows the
   * provider gives no market time for, money-market par rows, and exports
   * generated before this field was added.
   */
  last_price_time?: string | null;
  /**
   * The holding's prior published close in its native currency — the close one
   * trading day before `last_known_price_native`. Lets the web derive a today's
   * move (and rank the holding among the day's movers) from the export alone when
   * no usable *live* quote is available — e.g. a fund the live price provider has
   * stopped serving, whose fresh NAV still arrives via the blob. Null/absent on
   * rows with under two cached closes, and on exports generated before this field
   * was added (the web then shows no move for a blob-priced row, as before). */
  previous_close_native?: DecimalString | null;
  /** Trading day (`YYYY-MM-DD`) that `previous_close_native` was struck. Null/
   * absent alongside `previous_close_native`. */
  previous_close_date?: string | null;
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
  /**
   * The portfolio value re-marked at *each day's* FX rate (USD-denominated),
   * letting the web draw a currency-correct USD curve rather than rescaling the
   * EUR line at today's spot. Absent on exports predating this field.
   */
  portfolio_value_usd?: DecimalString | null;
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
 * analytics display); `transactions` is now typed (see {@link ExportTransactions})
 * and surfaced on the mobile Transactions tab when the desktop opts to include it.
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
  /** The desktop's already-captured live 1D/1W graph, for the web to springboard
   * off (instant paint, no re-fetch). Absent on exports predating schema v2 or
   * when no intraday history had been captured. */
  live_graphs?: ExportLiveGraphs;
  /** Cheap per-day history fingerprint (count, last date, short digest) so the
   * web can flag "history revised" when a late desktop import rewrote old days.
   * Absent on exports predating this field. */
  history_fingerprint?: ExportHistoryFingerprint;
  /** Raw ledger rows, present only when the desktop publishes with
   * `include_transactions=True`. Newest-first, already settlement-swept. Absent
   * (or `undefined`) on exports that opted out — the Transactions tab then shows
   * an empty/disabled state and can be hidden from Settings. */
  transactions?: ExportTransactions;
}

/**
 * The transactions read-model (`readmodels/transactions.py`): the raw ledger as
 * a flat, newest-first list of cash/holding movements. Each `net_*` figure is
 * the signed cash flow (money **in** is positive, **out** negative) converted at
 * the FX rate in force on that row's own date, so the EUR and USD legs reflect
 * the trade-date rate rather than today's spot.
 */
export interface ExportTransactions {
  rows: ExportTransactionRecord[];
}

/** One ledger row as exported for the mobile companion. */
export interface ExportTransactionRecord {
  /** Stable transaction id (may be null for synthesised rows). */
  id: number | null;
  /** Trade date, ISO `YYYY-MM-DD`. */
  date: string;
  /** Human-readable account label (e.g. "Taxable", "Pension"). */
  account: string;
  /** Ledger kind: `buy`, `sell`, `dividend`, `dividend_reinvest`, `deposit`, … */
  kind: string;
  /** Instrument symbol, or "" for pure cash movements. */
  symbol: string;
  /** Signed share quantity (negative for sells); null for cash-only rows. */
  quantity: DecimalString | null;
  /** Per-unit price in the row's native currency. */
  price_native: DecimalString | null;
  /** Fees in the native currency. */
  fees_native: DecimalString | null;
  /** Gross (pre-fee) amount in the native currency. */
  gross_native: DecimalString | null;
  /** Signed net cash flow in the native currency (in +, out −). */
  net_native: DecimalString | null;
  /** Signed net cash flow in EUR, at the trade-date FX rate. */
  net_eur: DecimalString | null;
  /** Signed net cash flow in USD, at the trade-date FX rate. */
  net_usd: DecimalString | null;
  /** Provenance of the row (`manual`, `import`, …), or null. */
  source: string | null;
}

/** Summary of the exported equity-curve history, for revision detection. */
export interface ExportHistoryFingerprint {
  /** Number of daily points in the exported curve. */
  days: number;
  /** Last `YYYY-MM-DD` covered, or null when the curve is empty. */
  last_date: string | null;
  /** Short stable digest over each day's `(date, whole-unit value)`. */
  digest: string;
}

/** One whole-book point of an exported live curve, in both currencies. */
export interface ExportLiveCurvePoint {
  /** ISO-8601 UTC instant (carries a `Z`), the point's time. */
  t: string;
  /** Whole-book EUR value (the constant cash + NAV base already folded in). */
  value_eur: DecimalString | null;
  /** Whole-book USD value (booked / FX-free; never a rescale of the EUR line). */
  value_usd: DecimalString | null;
}

/** One exported live series (the 1D session or the 1W sleeve). */
export interface ExportLiveGraphSeries {
  /** `YYYY-MM-DD` New-York session the 1D curve covers (1D series only). */
  session_date?: string;
  /** First `YYYY-MM-DD` New-York session of the 1W window (1W series only). */
  start_date?: string;
  /** Last `YYYY-MM-DD` New-York session of the 1W window (1W series only). */
  end_date?: string;
  /** Whether the regular session was open when the export was captured. */
  market_open?: boolean;
  points: ExportLiveCurvePoint[];
}

/**
 * The schema-v3 **aggregate market-sleeve backbone** (`docs/mobile_export_schema.md`):
 * the value of the intraday-priced sleeve only (cash + NAV deliberately excluded)
 * across the whole 1W window, in compact columnar form so it stays a few KB
 * regardless of symbol count. The three arrays are index-aligned and share one
 * length: `times[i]` ↔ `value_native[i]` ↔ `fx_eur_usd[i]`.
 *
 * Currency model: `value_native` is the FX-free booked (USD) sleeve value; the
 * EUR sleeve is recovered as `value_native[i] / fx_eur_usd[i]` (the rate in force
 * at that instant), so the two lines genuinely diverge — never a flat rescale. A
 * `null` in `value_native` marks a capture gap (skip the slot); a `null` in
 * `fx_eur_usd` tells the web to fall back to today's rate for that point.
 */
export interface ExportMarketSeries {
  /** True capture instants, ISO-8601 UTC (each carries a `Z`). */
  times: string[];
  /** FX-free booked (USD) sleeve value at each instant; `null` = a capture gap. */
  value_native: (DecimalString | null)[];
  /** EUR→USD rate in force at each instant; `null` → web uses today's rate. */
  fx_eur_usd: (DecimalString | null)[];
}

/**
 * The desktop's dense whole-book live captures shipped as a **display-only**
 * trail: like the web's own `session.tips`, these are rebased on import and
 * spliced *after* the freshest real point to thicken the line, but are **never**
 * merged into or cross-checked against the market-sleeve backbone.
 */
export interface ExportLiveTrail {
  /** Always `true` — the contract that bars this series from any reconciliation. */
  display_only: boolean;
  /** Whole-book points (same shape as a legacy series), downsampled for size. */
  points: ExportLiveCurvePoint[];
}

/**
 * The desktop's live 1D/1W graphs, serialized so the web can springboard the
 * curve from the blob instead of re-fetching intraday bars. `captured_at` stamps
 * when the desktop built it, so the web can judge freshness and never present a
 * stale session as the live one.
 *
 * Schema v3 adds the **market-sleeve backbone** ({@link market_series} +
 * {@link daily_close_native} + {@link nav_prices} + {@link mm_value_native} +
 * {@link trail}); these are all optional so a reader stays tolerant of older
 * v1/v2 exports that omit them (graceful degradation — the legacy `day`/`week`
 * curves still drive the render).
 */
export interface ExportLiveGraphs {
  /** ISO-8601 UTC instant the export was captured (the freshness stamp). */
  captured_at: string;
  /** Bucketing grid the desktop sampled the backbone on (`"30m"` default). */
  grid?: "30m" | "15m";
  /** `YYYY-MM-DD` New-York sessions the 1W window spans (oldest first). */
  session_dates?: string[];
  /** v3 aggregate market-sleeve series across the whole window (absent on v1/v2). */
  market_series?: ExportMarketSeries | null;
  /** v3 settled sleeve close (native USD) per session date, `{ "YYYY-MM-DD": "…" }`. */
  daily_close_native?: Record<string, DecimalString | null>;
  /** v3 per-day published NAV per NAV/cash holding: `{ symbol: [[date, price], …] }`. */
  nav_prices?: Record<string, [string, DecimalString | null][]>;
  /**
   * v3 per-day money-market / settlement **value** (native USD) per fund:
   * `{ "VMFXX": [[date, value], …] }`. Money-market funds pin a constant $1.00
   * NAV, so a NAV *price* line is flat and uninformative; their value moves with
   * the share count, which transactions (deposits/dividends) change — sometimes
   * while the market is shut, so the freshest balance is *newer* than the last
   * market close. This ships the value-as-of each session date so the base can
   * step on the day a flow landed instead of shifting the whole curve up by
   * today's balance. `[-1]` is the latest settled close per fund. */
  mm_value_native?: Record<string, [string, DecimalString | null][]>;
  /** v3 display-only dense whole-book trail (never merged/cross-checked). */
  trail?: ExportLiveTrail | null;
  /** The intraday 1D session, if the desktop had one to ship. */
  day?: ExportLiveGraphSeries | null;
  /** The multi-day 1W sleeve, if the desktop had one to ship. */
  week?: ExportLiveGraphSeries | null;
}
