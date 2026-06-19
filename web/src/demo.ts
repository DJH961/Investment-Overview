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
    month_start_value_eur: "47200",
    year_start_value_eur: "44100",
    holdings: {},
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
