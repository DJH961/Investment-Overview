/**
 * Demo / preview mode — a self-contained sample dashboard.
 *
 * This lets anyone *see and click through the UI* without an API key, a mobile
 * passphrase, or a published `portfolio.enc` blob: the data below is entirely
 * synthetic and the prices/FX are baked in, so nothing is fetched from the
 * network and no real financial data is involved.
 *
 * It reuses the real `buildDashboard` pipeline so the preview renders with the
 * exact same compute + layout code as the live app — only the inputs are stubs.
 * A fixed "now" keeps the figures (and the XIRR) stable between reloads.
 */
import { Decimal } from "./decimal-config";
import { buildDashboard, type DashboardModel } from "./compute";
import type { FxRates, Quote } from "./prices";
import type { MobileExport } from "./types";

/** Frozen "today" so the sample XIRR and dates are deterministic. */
const DEMO_NOW = new Date("2026-06-19T12:00:00Z");

const DEMO_EXPORT: MobileExport = {
  meta: {
    schema_version: 1,
    app_version: "demo",
    generated_at: "2026-06-19T08:00:00+00:00",
    as_of: "2026-06-19",
    display_currency: "EUR",
    fx_pivot: "EUR",
    fx_rate_eur_usd: "1.08",
    currency_note: "Sample data — not a real portfolio.",
  },
  holdings: [
    {
      symbol: "VWCE",
      name: "Vanguard FTSE All-World UCITS ETF",
      asset_class: "etf",
      broker: "Sample Broker",
      account: "Taxable",
      native_currency: "EUR",
      shares: "120",
      cost_basis_native: "11400",
      cumulative_dividends_cash_native: "210",
      price_symbol: "VWCE",
      price_type: "market",
      last_known_price_native: "118.00",
      cashflows: [
        { date: "2023-02-15", amount: "-6000" },
        { date: "2024-05-20", amount: "-5400" },
      ],
    },
    {
      symbol: "AAPL",
      name: "Apple Inc.",
      asset_class: "equity",
      broker: "Sample Broker",
      account: "Taxable",
      native_currency: "USD",
      shares: "40",
      cost_basis_native: "6800",
      cumulative_dividends_cash_native: "96",
      price_symbol: "AAPL",
      price_type: "market",
      last_known_price_native: "205.00",
      cashflows: [{ date: "2023-09-01", amount: "-6800" }],
    },
    {
      symbol: "MSFT",
      name: "Microsoft Corporation",
      asset_class: "equity",
      broker: "Sample Broker",
      account: "Pension",
      native_currency: "USD",
      shares: "15",
      cost_basis_native: "5100",
      cumulative_dividends_cash_native: "45",
      price_symbol: "MSFT",
      price_type: "market",
      last_known_price_native: "430.00",
      cashflows: [{ date: "2024-01-10", amount: "-5100" }],
    },
    {
      symbol: "AGGH",
      name: "iShares Core Global Aggregate Bond UCITS ETF",
      asset_class: "bond",
      broker: "Sample Broker",
      account: "Taxable",
      native_currency: "EUR",
      shares: "300",
      cost_basis_native: "1500",
      cumulative_dividends_cash_native: "60",
      price_symbol: "AGGH",
      price_type: "market",
      last_known_price_native: "4.95",
      cashflows: [{ date: "2023-11-05", amount: "-1500" }],
    },
    {
      symbol: "VMFXX",
      name: "Vanguard Federal Money Market Fund",
      asset_class: "money_market",
      broker: "Sample Broker",
      account: "Taxable",
      native_currency: "USD",
      shares: "3000",
      cost_basis_native: "3000",
      cumulative_dividends_cash_native: "130",
      price_symbol: "VMFXX",
      price_type: "nav",
      last_known_price_native: "1.00",
      cashflows: [{ date: "2024-03-01", amount: "-3000" }],
    },
  ],
  portfolio_cashflows: [
    { date: "2023-02-15", amount: "-6000" },
    { date: "2023-09-01", amount: "-6800" },
    { date: "2023-11-05", amount: "-1500" },
    { date: "2024-01-10", amount: "-5100" },
    { date: "2024-03-01", amount: "-3000" },
    { date: "2024-05-20", amount: "-5400" },
  ],
  cash: [
    { account_label: "Cash", broker: "Sample Broker", native_currency: "EUR", balance_native: "2500" },
    { account_label: "USD savings", broker: "Sample Broker", native_currency: "USD", balance_native: "1200" },
  ],
  period_openings: {
    month_start_value_eur: "35800",
    year_start_value_eur: "33000",
    holdings: {},
  },
  monthly: {
    rows: [
      {
        label: "2026-01",
        contributions_eur: "1200", dividends_eur: "0", interest_eur: "5",
        net_flow_eur: "1205", opening_value_eur: "33000", closing_value_eur: "34800", growth_pct: "0.018",
      },
      {
        label: "2026-02",
        contributions_eur: "1200", dividends_eur: "60", interest_eur: "4",
        net_flow_eur: "1264", opening_value_eur: "34800", closing_value_eur: "35200", growth_pct: "-0.025",
      },
      {
        label: "2026-03",
        contributions_eur: "1200", dividends_eur: "0", interest_eur: "5",
        net_flow_eur: "1205", opening_value_eur: "35200", closing_value_eur: "37100", growth_pct: "0.020",
      },
      {
        label: "2026-04",
        contributions_eur: "1200", dividends_eur: "90", interest_eur: "4",
        net_flow_eur: "1294", opening_value_eur: "37100", closing_value_eur: "37000", growth_pct: "-0.038",
      },
      {
        label: "2026-05",
        contributions_eur: "1200", dividends_eur: "0", interest_eur: "6",
        net_flow_eur: "1206", opening_value_eur: "37000", closing_value_eur: "38400", growth_pct: "0.006",
      },
      {
        label: "2026-06",
        contributions_eur: "1200", dividends_eur: "0", interest_eur: "5",
        net_flow_eur: "1205", opening_value_eur: "35800", closing_value_eur: "39000", growth_pct: "0.040",
      },
    ],
  },
  yearly: {
    rows: [
      {
        label: "2023",
        contributions_eur: "7500", dividends_eur: "120", interest_eur: "30",
        net_flow_eur: "7650", opening_value_eur: "0", closing_value_eur: "8200", growth_pct: "0.072",
      },
      {
        label: "2024",
        contributions_eur: "13500", dividends_eur: "240", interest_eur: "85",
        net_flow_eur: "13825", opening_value_eur: "8200", closing_value_eur: "24800", growth_pct: "0.118",
      },
      {
        label: "2025",
        contributions_eur: "9000", dividends_eur: "300", interest_eur: "110",
        net_flow_eur: "9410", opening_value_eur: "24800", closing_value_eur: "33000", growth_pct: "0.094",
      },
      {
        label: "2026",
        contributions_eur: "7200", dividends_eur: "150", interest_eur: "29",
        net_flow_eur: "7379", opening_value_eur: "33000", closing_value_eur: "39000", growth_pct: "0.061",
      },
    ],
  },
  analytics: {
    as_of: "2026-06-19", start: "2025-06-19", currency: "EUR",
    cagr: "0.112", twr: "0.118", xirr: "0.121",
    volatility: "0.142", sharpe: "0.92", sortino: "1.31",
    max_drawdown: "-0.168", calmar: "0.67", ulcer: "4.8",
    var_95: "-0.021", cvar_95: "-0.032", skew: "-0.35", kurtosis: "1.8",
    beta: "0.94", alpha: "0.021", risk_free_rate: "0.025",
    risk_free_symbol: "EURIBOR", benchmark_symbol: "VWCE",
    curve: [
      { date: "2025-06-30", portfolio_value: "31000", cumulative_contributions: "29000", benchmark_value: "31000" },
      { date: "2025-08-31", portfolio_value: "32200", cumulative_contributions: "30200", benchmark_value: "32000" },
      { date: "2025-10-31", portfolio_value: "31500", cumulative_contributions: "31400", benchmark_value: "31800" },
      { date: "2025-12-31", portfolio_value: "33000", cumulative_contributions: "32600", benchmark_value: "33200" },
      { date: "2026-02-28", portfolio_value: "35200", cumulative_contributions: "35000", benchmark_value: "35600" },
      { date: "2026-04-30", portfolio_value: "37000", cumulative_contributions: "37400", benchmark_value: "37100" },
      { date: "2026-06-19", portfolio_value: "39000", cumulative_contributions: "39800", benchmark_value: "39200" },
    ],
    attribution: [
      { instrument_id: 1, symbol: "VWCE", start_value: "11000", end_value: "14568", net_contribution: "0", absolute_pnl: "3568", pct_of_total_return: "0.52" },
      { instrument_id: 2, symbol: "MSFT", start_value: "5100", end_value: "6720", net_contribution: "0", absolute_pnl: "1620", pct_of_total_return: "0.24" },
      { instrument_id: 3, symbol: "AAPL", start_value: "6800", end_value: "8492", net_contribution: "0", absolute_pnl: "1692", pct_of_total_return: "0.25" },
      { instrument_id: 4, symbol: "AGGH", start_value: "1500", end_value: "1494", net_contribution: "0", absolute_pnl: "-6", pct_of_total_return: "-0.01" },
    ],
  },
  deposits: {
    summary: { total_contrib_eur: "37200", ytd_contrib_eur: "7200", mtd_contrib_eur: "1200" },
    rows: [
      { id: 6, date: "2026-06-01", account: "Taxable", kind: "contribution", amount_eur: "1200", currency: "EUR", description: "Monthly savings" },
      { id: 5, date: "2026-05-01", account: "Taxable", kind: "contribution", amount_eur: "1200", currency: "EUR", description: "Monthly savings" },
      { id: 4, date: "2026-04-01", account: "Taxable", kind: "contribution", amount_eur: "1200", currency: "EUR", description: "Monthly savings" },
      { id: 3, date: "2024-05-20", account: "Taxable", kind: "contribution", amount_eur: "5400", currency: "EUR", description: "Lump sum" },
      { id: 2, date: "2023-09-01", account: "Taxable", kind: "contribution", amount_eur: "6800", currency: "EUR", description: "Initial AAPL buy" },
      { id: 1, date: "2023-02-15", account: "Taxable", kind: "contribution", amount_eur: "6000", currency: "EUR", description: "Initial VWCE buy" },
    ],
  },
};

/** Baked-in EUR-based FX (rates[X] = units of X per 1 EUR). */
const DEMO_FX: FxRates = { base: "EUR", rates: { USD: new Decimal("1.08") } };

function quote(symbol: string, price: string, previousClose: string, currency: string): Quote {
  return {
    symbol,
    price: new Decimal(price),
    previousClose: new Decimal(previousClose),
    currency,
  };
}

/** Baked-in live quotes for the market-priced holdings (mix of up/down days). */
const DEMO_QUOTES = new Map<string, Quote>([
  ["VWCE", quote("VWCE", "121.40", "120.10", "EUR")],
  ["AAPL", quote("AAPL", "212.30", "214.80", "USD")],
  ["MSFT", quote("MSFT", "448.00", "442.50", "USD")],
  ["AGGH", quote("AGGH", "4.98", "4.97", "EUR")],
  // VMFXX (NAV) intentionally absent → falls back to last_known_price_native.
]);

/** Build the sample dashboard model using the real compute pipeline. */
export function buildDemoModel(): DashboardModel {
  return buildDashboard(DEMO_EXPORT, DEMO_QUOTES, DEMO_FX, DEMO_NOW);
}
