/**
 * Demo / preview mode — self-contained sample dashboards.
 *
 * This lets anyone *see and click through the UI* without an API key, a mobile
 * passphrase, or a published `portfolio.enc` blob: the data below is entirely
 * synthetic and the prices/FX are baked in, so nothing is fetched from the
 * network and no real financial data is involved.
 *
 * It reuses the real `buildDashboard` pipeline so the preview renders with the
 * exact same compute + layout code as the live app — only the inputs are stubs.
 * A fixed "now" keeps the figures (and the XIRR) stable between reloads.
 *
 * The demo is built around three things that make it interview-ready while
 * staying 100% offline and secret-free:
 *
 *   1. **Personas** — a small registry of distinct sample portfolios (a global
 *      ETF saver, a US tech-heavy book, an FX-diverging euro investor) so a
 *      single screen can tell different stories. Deep-linkable via `?demo=tech`.
 *   2. **A seeded live-tick simulator** — `buildDemoModel({ persona, tick })`
 *      nudges the baked market quotes within a small, deterministic band so the
 *      headline value, today's move and freshness chips visibly *move* on each
 *      refresh, with no network and fully reproducible figures.
 *   3. **Deep-linking** — `parseDemoParams` reads `?demo=…&tab=…&tour=…&sim=…`
 *      so a shared link can boot straight into a chosen persona, tab and tour.
 */
import { Decimal } from "./decimal-config";
import { buildDashboard, type DashboardModel } from "./compute";
import type { FxRates, Quote } from "./prices";
import type { MobileExport } from "./types";

/** Frozen "today" so the sample XIRR and dates are deterministic. */
const DEMO_NOW = new Date("2026-06-19T12:00:00Z");

function quote(symbol: string, price: string, previousClose: string, currency: string): Quote {
  return {
    symbol,
    price: new Decimal(price),
    previousClose: new Decimal(previousClose),
    currency,
    // Stamp the preview "now" so demo rows show a realistic freshness time. The
    // live-tick simulator keys off this `at` to know which quotes are market
    // (intraday-moving) prices versus once-a-day NAV bars.
    at: DEMO_NOW.getTime(),
  };
}

/** A NAV (mutual-fund) quote: a daily bar with a value-date and prior close,
 *  but no intraday strike time — mirrors what `time_series` returns for funds. */
function navQuote(symbol: string, price: string, previousClose: string, currency: string, valueDate: string): Quote {
  return {
    symbol,
    price: new Decimal(price),
    previousClose: new Decimal(previousClose),
    currency,
    at: null,
    priceTime: null,
    valueDate,
  };
}

// ---------------------------------------------------------------------------
// Persona 1 — "Global ETF saver" (the original balanced sample)
// ---------------------------------------------------------------------------

const BALANCED_EXPORT: MobileExport = {
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
      symbol: "FCNTX",
      name: "Fidelity Contrafund",
      asset_class: "mutual_fund",
      broker: "Sample Broker",
      account: "Pension",
      native_currency: "USD",
      shares: "200",
      cost_basis_native: "3400",
      cumulative_dividends_cash_native: "0",
      price_symbol: "FCNTX",
      price_type: "nav",
      last_known_price_native: "19.80",
      last_price_date: "2026-06-19",
      cashflows: [{ date: "2024-02-01", amount: "-3400" }],
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
    { date: "2024-02-01", amount: "-3400" },
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
    // USD-view companions: a euro investor's dollar returns look different once
    // you strip the FX move out, so the demo toggles visibly between currencies.
    cagr_usd: "0.131", twr_usd: "0.137", xirr_usd: "0.140",
    volatility_usd: "0.151", sharpe_usd: "0.98", sortino_usd: "1.39",
    max_drawdown_usd: "-0.176", calmar_usd: "0.74", ulcer_usd: "5.1",
    var_95_usd: "-0.023", cvar_95_usd: "-0.034", skew_usd: "-0.31", kurtosis_usd: "1.7",
    beta_usd: "0.96", alpha_usd: "0.018",
    curve: [
      { date: "2025-06-30", portfolio_value: "31000", cumulative_contributions: "29000", benchmark_value: "112.00" },
      { date: "2025-08-31", portfolio_value: "32200", cumulative_contributions: "30200", benchmark_value: "115.60" },
      { date: "2025-10-31", portfolio_value: "31500", cumulative_contributions: "31400", benchmark_value: "114.90" },
      { date: "2025-12-31", portfolio_value: "33000", cumulative_contributions: "32600", benchmark_value: "119.90" },
      { date: "2026-02-28", portfolio_value: "34200", cumulative_contributions: "35000", benchmark_value: "122.80" },
      { date: "2026-04-30", portfolio_value: "35200", cumulative_contributions: "37400", benchmark_value: "124.10" },
      { date: "2026-06-19", portfolio_value: "36400", cumulative_contributions: "39800", benchmark_value: "126.40" },
    ],
    attribution: [
      { instrument_id: 1, symbol: "VWCE", start_value: "11000", end_value: "14568", net_contribution: "0", absolute_pnl: "3568", pct_of_total_return: "0.52" },
      { instrument_id: 2, symbol: "MSFT", start_value: "5100", end_value: "6720", net_contribution: "0", absolute_pnl: "1620", pct_of_total_return: "0.24" },
      { instrument_id: 3, symbol: "AAPL", start_value: "6800", end_value: "8492", net_contribution: "0", absolute_pnl: "1692", pct_of_total_return: "0.25" },
      { instrument_id: 4, symbol: "AGGH", start_value: "1500", end_value: "1494", net_contribution: "0", absolute_pnl: "-6", pct_of_total_return: "-0.01" },
    ],
  },
  deposits: {
    summary: { total_contrib_eur: "37200", ytd_contrib_eur: "7200", mtd_contrib_eur: "1200", total_contrib_usd: "40100", ytd_contrib_usd: "7850", mtd_contrib_usd: "1296" },
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
const BALANCED_FX: FxRates = { base: "EUR", rates: { USD: new Decimal("1.08") } };

/**
 * The prior session's EUR/USD close, a touch lower than today's spot so the
 * preview demonstrates the FX-aware today's move (a slice of the move comes
 * from the EUR/USD swing on the USD holdings, surfaced as the hero's
 * "incl. … from FX" line and the live EUR/USD chip).
 */
const BALANCED_FX_PREV_EUR_USD = new Decimal("1.0725");

/** Baked-in live quotes for the market-priced holdings (mix of up/down days). */
const BALANCED_QUOTES = new Map<string, Quote>([
  ["VWCE", quote("VWCE", "121.40", "120.10", "EUR")],
  ["AAPL", quote("AAPL", "212.30", "214.80", "USD")],
  ["MSFT", quote("MSFT", "448.00", "442.50", "USD")],
  ["AGGH", quote("AGGH", "4.98", "4.97", "EUR")],
  // A mutual fund (NAV) priced from a daily bar: shows a today's move from the
  // prior close, just like a stock — the headline feature this demo showcases.
  ["FCNTX", navQuote("FCNTX", "19.80", "19.60", "USD", "2026-06-19")],
  // VMFXX (money-market NAV) intentionally absent → falls back to its $1 value.
]);

// ---------------------------------------------------------------------------
// Persona 2 — "US tech-heavy" (concentration + a visible loser)
// ---------------------------------------------------------------------------

const TECH_EXPORT: MobileExport = {
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
      symbol: "NVDA", name: "NVIDIA Corporation", asset_class: "equity",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      shares: "60", cost_basis_native: "5400", cumulative_dividends_cash_native: "12",
      price_symbol: "NVDA", price_type: "market", last_known_price_native: "168.00",
      cashflows: [{ date: "2023-05-10", amount: "-5400" }],
    },
    {
      symbol: "AAPL", name: "Apple Inc.", asset_class: "equity",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      shares: "50", cost_basis_native: "8500", cumulative_dividends_cash_native: "120",
      price_symbol: "AAPL", price_type: "market", last_known_price_native: "205.00",
      cashflows: [{ date: "2023-03-01", amount: "-8500" }],
    },
    {
      symbol: "MSFT", name: "Microsoft Corporation", asset_class: "equity",
      broker: "Sample Broker", account: "Pension", native_currency: "USD",
      shares: "20", cost_basis_native: "6800", cumulative_dividends_cash_native: "60",
      price_symbol: "MSFT", price_type: "market", last_known_price_native: "430.00",
      cashflows: [{ date: "2023-07-15", amount: "-6800" }],
    },
    {
      symbol: "GOOGL", name: "Alphabet Inc. Class A", asset_class: "equity",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      shares: "35", cost_basis_native: "4900", cumulative_dividends_cash_native: "0",
      price_symbol: "GOOGL", price_type: "market", last_known_price_native: "176.00",
      cashflows: [{ date: "2024-01-20", amount: "-4900" }],
    },
    {
      symbol: "TSLA", name: "Tesla, Inc.", asset_class: "equity",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      // A deliberate loser so the colourblind-safe blue↔orange loss colour and a
      // negative attribution row both show up in the demo.
      shares: "25", cost_basis_native: "7500", cumulative_dividends_cash_native: "0",
      price_symbol: "TSLA", price_type: "market", last_known_price_native: "232.00",
      cashflows: [{ date: "2024-03-05", amount: "-7500" }],
    },
    {
      symbol: "QQQ", name: "Invesco QQQ Trust", asset_class: "etf",
      broker: "Sample Broker", account: "Pension", native_currency: "USD",
      shares: "30", cost_basis_native: "12000", cumulative_dividends_cash_native: "180",
      price_symbol: "QQQ", price_type: "market", last_known_price_native: "470.00",
      cashflows: [{ date: "2023-09-12", amount: "-12000" }],
    },
  ],
  portfolio_cashflows: [
    { date: "2023-03-01", amount: "-8500" },
    { date: "2023-05-10", amount: "-5400" },
    { date: "2023-07-15", amount: "-6800" },
    { date: "2023-09-12", amount: "-12000" },
    { date: "2024-01-20", amount: "-4900" },
    { date: "2024-03-05", amount: "-7500" },
  ],
  cash: [
    { account_label: "Settlement cash", broker: "Sample Broker", native_currency: "USD", balance_native: "1800" },
  ],
  period_openings: {
    month_start_value_eur: "58200",
    year_start_value_eur: "50400",
    holdings: {},
  },
  monthly: {
    rows: [
      { label: "2026-01", contributions_eur: "0", dividends_eur: "0", interest_eur: "0", net_flow_eur: "0", opening_value_eur: "50400", closing_value_eur: "53100", growth_pct: "0.054" },
      { label: "2026-02", contributions_eur: "0", dividends_eur: "60", interest_eur: "0", net_flow_eur: "60", opening_value_eur: "53100", closing_value_eur: "51200", growth_pct: "-0.037" },
      { label: "2026-03", contributions_eur: "0", dividends_eur: "0", interest_eur: "0", net_flow_eur: "0", opening_value_eur: "51200", closing_value_eur: "55800", growth_pct: "0.090" },
      { label: "2026-04", contributions_eur: "0", dividends_eur: "120", interest_eur: "0", net_flow_eur: "120", opening_value_eur: "55800", closing_value_eur: "54100", growth_pct: "-0.032" },
      { label: "2026-05", contributions_eur: "0", dividends_eur: "0", interest_eur: "0", net_flow_eur: "0", opening_value_eur: "54100", closing_value_eur: "58200", growth_pct: "0.076" },
      { label: "2026-06", contributions_eur: "0", dividends_eur: "0", interest_eur: "0", net_flow_eur: "0", opening_value_eur: "58200", closing_value_eur: "61000", growth_pct: "0.048" },
    ],
  },
  yearly: {
    rows: [
      { label: "2023", contributions_eur: "32700", dividends_eur: "90", interest_eur: "0", net_flow_eur: "32790", opening_value_eur: "0", closing_value_eur: "34800", growth_pct: "0.064" },
      { label: "2024", contributions_eur: "12400", dividends_eur: "180", interest_eur: "0", net_flow_eur: "12580", opening_value_eur: "34800", closing_value_eur: "47200", growth_pct: "0.142" },
      { label: "2025", contributions_eur: "0", dividends_eur: "240", interest_eur: "0", net_flow_eur: "240", opening_value_eur: "47200", closing_value_eur: "50400", growth_pct: "0.068" },
      { label: "2026", contributions_eur: "0", dividends_eur: "180", interest_eur: "0", net_flow_eur: "180", opening_value_eur: "50400", closing_value_eur: "61000", growth_pct: "0.210" },
    ],
  },
  analytics: {
    as_of: "2026-06-19", start: "2025-06-19", currency: "EUR",
    cagr: "0.196", twr: "0.205", xirr: "0.214",
    volatility: "0.268", sharpe: "0.81", sortino: "1.12",
    max_drawdown: "-0.312", calmar: "0.63", ulcer: "9.4",
    var_95: "-0.041", cvar_95: "-0.058", skew: "-0.52", kurtosis: "2.9",
    beta: "1.28", alpha: "0.034", risk_free_rate: "0.025",
    risk_free_symbol: "US3M", benchmark_symbol: "QQQ",
    cagr_usd: "0.214", twr_usd: "0.224", xirr_usd: "0.233",
    volatility_usd: "0.276", sharpe_usd: "0.86", sortino_usd: "1.18",
    max_drawdown_usd: "-0.320", calmar_usd: "0.69", ulcer_usd: "9.8",
    var_95_usd: "-0.043", cvar_95_usd: "-0.060", skew_usd: "-0.48", kurtosis_usd: "2.8",
    beta_usd: "1.31", alpha_usd: "0.031",
    curve: [
      { date: "2025-06-30", portfolio_value: "43000", cumulative_contributions: "45100", benchmark_value: "452.00" },
      { date: "2025-08-31", portfolio_value: "46800", cumulative_contributions: "45100", benchmark_value: "468.00" },
      { date: "2025-10-31", portfolio_value: "44200", cumulative_contributions: "45100", benchmark_value: "451.00" },
      { date: "2025-12-31", portfolio_value: "50400", cumulative_contributions: "45100", benchmark_value: "486.00" },
      { date: "2026-02-28", portfolio_value: "51200", cumulative_contributions: "45100", benchmark_value: "479.00" },
      { date: "2026-04-30", portfolio_value: "54100", cumulative_contributions: "45100", benchmark_value: "498.00" },
      { date: "2026-06-19", portfolio_value: "59200", cumulative_contributions: "45100", benchmark_value: "521.00" },
    ],
    attribution: [
      { instrument_id: 1, symbol: "NVDA", start_value: "5400", end_value: "10080", net_contribution: "0", absolute_pnl: "4680", pct_of_total_return: "0.41" },
      { instrument_id: 2, symbol: "QQQ", start_value: "12000", end_value: "14100", net_contribution: "0", absolute_pnl: "2100", pct_of_total_return: "0.18" },
      { instrument_id: 3, symbol: "AAPL", start_value: "8500", end_value: "10250", net_contribution: "0", absolute_pnl: "1750", pct_of_total_return: "0.15" },
      { instrument_id: 4, symbol: "MSFT", start_value: "6800", end_value: "8600", net_contribution: "0", absolute_pnl: "1800", pct_of_total_return: "0.16" },
      { instrument_id: 5, symbol: "GOOGL", start_value: "4900", end_value: "6160", net_contribution: "0", absolute_pnl: "1260", pct_of_total_return: "0.11" },
      { instrument_id: 6, symbol: "TSLA", start_value: "7500", end_value: "5800", net_contribution: "0", absolute_pnl: "-1700", pct_of_total_return: "-0.15" },
    ],
  },
  deposits: {
    summary: { total_contrib_eur: "45100", ytd_contrib_eur: "0", mtd_contrib_eur: "0", total_contrib_usd: "48700", ytd_contrib_usd: "0", mtd_contrib_usd: "0" },
    rows: [
      { id: 6, date: "2024-03-05", account: "Taxable", kind: "contribution", amount_eur: "7500", currency: "USD", description: "TSLA buy" },
      { id: 5, date: "2024-01-20", account: "Taxable", kind: "contribution", amount_eur: "4900", currency: "USD", description: "GOOGL buy" },
      { id: 4, date: "2023-09-12", account: "Pension", kind: "contribution", amount_eur: "12000", currency: "USD", description: "QQQ buy" },
      { id: 3, date: "2023-07-15", account: "Pension", kind: "contribution", amount_eur: "6800", currency: "USD", description: "MSFT buy" },
      { id: 2, date: "2023-05-10", account: "Taxable", kind: "contribution", amount_eur: "5400", currency: "USD", description: "NVDA buy" },
      { id: 1, date: "2023-03-01", account: "Taxable", kind: "contribution", amount_eur: "8500", currency: "USD", description: "AAPL buy" },
    ],
  },
};

const TECH_FX: FxRates = { base: "EUR", rates: { USD: new Decimal("1.08") } };
const TECH_FX_PREV_EUR_USD = new Decimal("1.0760");
const TECH_QUOTES = new Map<string, Quote>([
  ["NVDA", quote("NVDA", "171.20", "166.40", "USD")],
  ["AAPL", quote("AAPL", "208.10", "205.90", "USD")],
  ["MSFT", quote("MSFT", "451.00", "447.20", "USD")],
  ["GOOGL", quote("GOOGL", "178.40", "176.80", "USD")],
  // The loser keeps falling today — drives the blue↔orange loss colour.
  ["TSLA", quote("TSLA", "229.50", "234.10", "USD")],
  ["QQQ", quote("QQQ", "472.80", "469.30", "USD")],
]);

// ---------------------------------------------------------------------------
// Persona 3 — "FX-diverging euro investor" (a euro saver almost entirely in USD)
// ---------------------------------------------------------------------------

const FX_EXPORT: MobileExport = {
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
      symbol: "VOO", name: "Vanguard S&P 500 ETF", asset_class: "etf",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      shares: "45", cost_basis_native: "19800", cumulative_dividends_cash_native: "320",
      price_symbol: "VOO", price_type: "market", last_known_price_native: "498.00",
      cashflows: [{ date: "2023-04-01", amount: "-19800" }],
    },
    {
      symbol: "SCHD", name: "Schwab US Dividend Equity ETF", asset_class: "etf",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      shares: "200", cost_basis_native: "5400", cumulative_dividends_cash_native: "410",
      price_symbol: "SCHD", price_type: "market", last_known_price_native: "28.40",
      cashflows: [{ date: "2023-06-20", amount: "-5400" }],
    },
    {
      symbol: "BRK.B", name: "Berkshire Hathaway Inc. Class B", asset_class: "equity",
      broker: "Sample Broker", account: "Pension", native_currency: "USD",
      shares: "20", cost_basis_native: "8000", cumulative_dividends_cash_native: "0",
      price_symbol: "BRK.B", price_type: "market", last_known_price_native: "470.00",
      cashflows: [{ date: "2024-02-12", amount: "-8000" }],
    },
    {
      symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", asset_class: "bond",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      shares: "120", cost_basis_native: "10800", cumulative_dividends_cash_native: "540",
      price_symbol: "TLT", price_type: "market", last_known_price_native: "92.00",
      cashflows: [{ date: "2023-10-02", amount: "-10800" }],
    },
    {
      symbol: "IWDA", name: "iShares Core MSCI World UCITS ETF (EUR)", asset_class: "etf",
      broker: "Sample Broker", account: "Taxable", native_currency: "EUR",
      // The lone EUR holding, so the EUR/USD divergence on the rest stands out.
      shares: "80", cost_basis_native: "6400", cumulative_dividends_cash_native: "0",
      price_symbol: "IWDA", price_type: "market", last_known_price_native: "92.00",
      cashflows: [{ date: "2024-04-18", amount: "-6400" }],
    },
    {
      symbol: "SWVXX", name: "Schwab Value Advantage Money Fund", asset_class: "money_market",
      broker: "Sample Broker", account: "Taxable", native_currency: "USD",
      shares: "4000", cost_basis_native: "4000", cumulative_dividends_cash_native: "190",
      price_symbol: "SWVXX", price_type: "nav", last_known_price_native: "1.00",
      cashflows: [{ date: "2024-05-01", amount: "-4000" }],
    },
  ],
  portfolio_cashflows: [
    { date: "2023-04-01", amount: "-19800" },
    { date: "2023-06-20", amount: "-5400" },
    { date: "2023-10-02", amount: "-10800" },
    { date: "2024-02-12", amount: "-8000" },
    { date: "2024-04-18", amount: "-6400" },
    { date: "2024-05-01", amount: "-4000" },
  ],
  cash: [
    { account_label: "EUR current", broker: "Sample Broker", native_currency: "EUR", balance_native: "3200" },
  ],
  period_openings: {
    month_start_value_eur: "57600",
    year_start_value_eur: "54000",
    holdings: {},
  },
  monthly: {
    rows: [
      { label: "2026-01", contributions_eur: "0", dividends_eur: "120", interest_eur: "8", net_flow_eur: "128", opening_value_eur: "54000", closing_value_eur: "55200", growth_pct: "0.020" },
      { label: "2026-02", contributions_eur: "0", dividends_eur: "0", interest_eur: "7", net_flow_eur: "7", opening_value_eur: "55200", closing_value_eur: "54300", growth_pct: "-0.016" },
      { label: "2026-03", contributions_eur: "0", dividends_eur: "180", interest_eur: "8", net_flow_eur: "188", opening_value_eur: "54300", closing_value_eur: "56400", growth_pct: "0.035" },
      { label: "2026-04", contributions_eur: "0", dividends_eur: "0", interest_eur: "7", net_flow_eur: "7", opening_value_eur: "56400", closing_value_eur: "55900", growth_pct: "-0.009" },
      { label: "2026-05", contributions_eur: "0", dividends_eur: "160", interest_eur: "8", net_flow_eur: "168", opening_value_eur: "55900", closing_value_eur: "57600", growth_pct: "0.027" },
      { label: "2026-06", contributions_eur: "0", dividends_eur: "0", interest_eur: "8", net_flow_eur: "8", opening_value_eur: "57600", closing_value_eur: "58900", growth_pct: "0.022" },
    ],
  },
  yearly: {
    rows: [
      { label: "2023", contributions_eur: "36000", dividends_eur: "300", interest_eur: "40", net_flow_eur: "36340", opening_value_eur: "0", closing_value_eur: "38200", growth_pct: "0.052" },
      { label: "2024", contributions_eur: "18400", dividends_eur: "520", interest_eur: "120", net_flow_eur: "19040", opening_value_eur: "38200", closing_value_eur: "52600", growth_pct: "0.061" },
      { label: "2025", contributions_eur: "0", dividends_eur: "640", interest_eur: "150", net_flow_eur: "790", opening_value_eur: "52600", closing_value_eur: "54000", growth_pct: "0.012" },
      { label: "2026", contributions_eur: "0", dividends_eur: "460", interest_eur: "46", net_flow_eur: "506", opening_value_eur: "54000", closing_value_eur: "58900", growth_pct: "0.082" },
    ],
  },
  analytics: {
    as_of: "2026-06-19", start: "2025-06-19", currency: "EUR",
    cagr: "0.088", twr: "0.094", xirr: "0.097",
    volatility: "0.118", sharpe: "0.74", sortino: "1.02",
    max_drawdown: "-0.142", calmar: "0.62", ulcer: "4.1",
    var_95: "-0.018", cvar_95: "-0.027", skew: "-0.28", kurtosis: "1.5",
    beta: "0.78", alpha: "0.012", risk_free_rate: "0.025",
    risk_free_symbol: "EURIBOR", benchmark_symbol: "VOO",
    // The headline of this persona: USD returns run well above the EUR view
    // because the euro strengthened over the window — strip the FX out and the
    // dollar performance is clearly stronger.
    cagr_usd: "0.134", twr_usd: "0.141", xirr_usd: "0.146",
    volatility_usd: "0.131", sharpe_usd: "0.91", sortino_usd: "1.24",
    max_drawdown_usd: "-0.151", calmar_usd: "0.71", ulcer_usd: "4.4",
    var_95_usd: "-0.020", cvar_95_usd: "-0.030", skew_usd: "-0.24", kurtosis_usd: "1.4",
    beta_usd: "0.82", alpha_usd: "0.019",
    curve: [
      { date: "2025-06-30", portfolio_value: "49500", cumulative_contributions: "54400", benchmark_value: "470.00" },
      { date: "2025-08-31", portfolio_value: "51200", cumulative_contributions: "54400", benchmark_value: "482.00" },
      { date: "2025-10-31", portfolio_value: "50100", cumulative_contributions: "54400", benchmark_value: "475.00" },
      { date: "2025-12-31", portfolio_value: "54000", cumulative_contributions: "54400", benchmark_value: "498.00" },
      { date: "2026-02-28", portfolio_value: "54300", cumulative_contributions: "54400", benchmark_value: "501.00" },
      { date: "2026-04-30", portfolio_value: "55900", cumulative_contributions: "54400", benchmark_value: "512.00" },
      { date: "2026-06-19", portfolio_value: "57700", cumulative_contributions: "54400", benchmark_value: "523.00" },
    ],
    attribution: [
      { instrument_id: 1, symbol: "VOO", start_value: "19800", end_value: "22410", net_contribution: "0", absolute_pnl: "2610", pct_of_total_return: "0.46" },
      { instrument_id: 2, symbol: "BRK.B", start_value: "8000", end_value: "9400", net_contribution: "0", absolute_pnl: "1400", pct_of_total_return: "0.25" },
      { instrument_id: 3, symbol: "SCHD", start_value: "5400", end_value: "5680", net_contribution: "0", absolute_pnl: "280", pct_of_total_return: "0.05" },
      { instrument_id: 4, symbol: "IWDA", start_value: "6400", end_value: "7360", net_contribution: "0", absolute_pnl: "960", pct_of_total_return: "0.17" },
      { instrument_id: 5, symbol: "TLT", start_value: "10800", end_value: "11040", net_contribution: "0", absolute_pnl: "240", pct_of_total_return: "0.04" },
    ],
  },
  deposits: {
    summary: { total_contrib_eur: "54400", ytd_contrib_eur: "0", mtd_contrib_eur: "0", total_contrib_usd: "58800", ytd_contrib_usd: "0", mtd_contrib_usd: "0" },
    rows: [
      { id: 6, date: "2024-05-01", account: "Taxable", kind: "contribution", amount_eur: "4000", currency: "USD", description: "SWVXX buy" },
      { id: 5, date: "2024-04-18", account: "Taxable", kind: "contribution", amount_eur: "6400", currency: "EUR", description: "IWDA buy" },
      { id: 4, date: "2024-02-12", account: "Pension", kind: "contribution", amount_eur: "8000", currency: "USD", description: "BRK.B buy" },
      { id: 3, date: "2023-10-02", account: "Taxable", kind: "contribution", amount_eur: "10800", currency: "USD", description: "TLT buy" },
      { id: 2, date: "2023-06-20", account: "Taxable", kind: "contribution", amount_eur: "5400", currency: "USD", description: "SCHD buy" },
      { id: 1, date: "2023-04-01", account: "Taxable", kind: "contribution", amount_eur: "19800", currency: "USD", description: "VOO buy" },
    ],
  },
};

const FX_FX: FxRates = { base: "EUR", rates: { USD: new Decimal("1.08") } };
// A wider prior→now EUR/USD swing so the FX-aware today's move is unmistakable.
const FX_FX_PREV_EUR_USD = new Decimal("1.0680");
const FX_QUOTES = new Map<string, Quote>([
  ["VOO", quote("VOO", "501.30", "499.10", "USD")],
  ["SCHD", quote("SCHD", "28.62", "28.45", "USD")],
  ["BRK.B", quote("BRK.B", "472.40", "470.80", "USD")],
  ["TLT", quote("TLT", "91.40", "92.30", "USD")],
  ["IWDA", quote("IWDA", "92.60", "92.10", "EUR")],
  // SWVXX (money-market NAV) intentionally absent → falls back to its $1 value.
]);

// ---------------------------------------------------------------------------
// Persona registry
// ---------------------------------------------------------------------------

export interface DemoPersona {
  /** Stable id used in the `?demo=<id>` deep link and the banner switcher. */
  id: string;
  /** Short label for the switcher. */
  label: string;
  /** One-line "story" shown in the banner. */
  tagline: string;
  export: MobileExport;
  quotes: Map<string, Quote>;
  fx: FxRates;
  fxPrevEurUsd: Decimal;
}

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  {
    id: "global",
    label: "Global ETF saver",
    tagline: "A diversified buy-and-hold book — world ETF, a bond fund, a money-market sweep and two blue chips.",
    export: BALANCED_EXPORT,
    quotes: BALANCED_QUOTES,
    fx: BALANCED_FX,
    fxPrevEurUsd: BALANCED_FX_PREV_EUR_USD,
  },
  {
    id: "tech",
    label: "US tech-heavy",
    tagline: "A concentrated growth book (incl. a deliberate loser) — bigger swings, fatter drawdowns, higher beta.",
    export: TECH_EXPORT,
    quotes: TECH_QUOTES,
    fx: TECH_FX,
    fxPrevEurUsd: TECH_FX_PREV_EUR_USD,
  },
  {
    id: "fx",
    label: "FX-diverging euro investor",
    tagline: "A euro saver almost entirely in USD assets — flip the currency toggle to watch EUR and USD diverge.",
    export: FX_EXPORT,
    quotes: FX_QUOTES,
    fx: FX_FX,
    fxPrevEurUsd: FX_FX_PREV_EUR_USD,
  },
];

/** The persona shown when `?demo` carries no (recognised) id. */
export const DEFAULT_PERSONA_ID = DEMO_PERSONAS[0].id;

/** Look up a persona by id, falling back to the default when unknown. */
export function getPersona(id: string | null | undefined): DemoPersona {
  return DEMO_PERSONAS.find((p) => p.id === id) ?? DEMO_PERSONAS[0];
}

// ---------------------------------------------------------------------------
// Seeded live-tick simulator
// ---------------------------------------------------------------------------

/** Largest fraction of the base price a single market quote can wander. */
const TICK_MAX_AMPLITUDE = 0.008; // 0.8%

/**
 * Deterministic 32-bit hash of a string, used to seed each symbol's tick phase.
 *
 * Uses FNV-1a (offset basis 0x811c9dc5, prime 0x01000193 — see
 * http://www.isthe.com/chongo/tech/comp/fnv/): a tiny, dependency-free hash with
 * good avalanche/distribution for short ASCII tickers, so distinct symbols get
 * well-spread phases. It is not cryptographic — only stable spreading is needed.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned.
  return hash >>> 0;
}

/**
 * Nudge the market quotes for a deterministic "tick". Each market price follows
 * a smooth sine wave keyed off a per-symbol phase, bounded to a small band, so
 * the headline value and today's move *move* on every refresh while never
 * jumping alarmingly — and always reproduce for a given `(persona, tick)`.
 *
 * `tick === 0` returns the baked prices unchanged (the "frozen" snapshot used
 * for screenshots and the existing tests). Only quotes that represent live
 * *market* prices are touched; once-a-day NAV bars (mutual funds, money-market
 * funds) keep their published value, exactly like the real app.
 */
export function tickQuotes(base: Map<string, Quote>, tick: number): Map<string, Quote> {
  if (tick === 0) return new Map(base);
  const next = new Map<string, Quote>();
  for (const [symbol, q] of base) {
    // Only intraday market quotes (stamped with `at`) move; NAV bars don't.
    if (q.at == null || q.price === null) {
      next.set(symbol, q);
      continue;
    }
    const seed = hashString(symbol);
    const phase = (seed % 360) * (Math.PI / 180);
    // A per-symbol amplitude in [0.4%, 0.8%] so symbols don't move in lockstep.
    const amplitude = TICK_MAX_AMPLITUDE * (0.5 + 0.5 * (((seed >>> 9) % 1000) / 1000));
    const wave = Math.sin(tick * 0.35 + phase);
    const factor = 1 + amplitude * wave;
    next.set(symbol, { ...q, price: q.price.times(factor) });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

export interface BuildDemoOptions {
  /** Persona id (see {@link DEMO_PERSONAS}); defaults to the global saver. */
  persona?: string;
  /** Live-tick index for the offline price simulator; 0 = frozen snapshot. */
  tick?: number;
}

/**
 * Build a sample dashboard model using the real compute pipeline. With no
 * arguments it returns the default persona's frozen snapshot (stable across
 * reloads); pass a `persona` and/or `tick` to switch the sample or advance the
 * offline live-tick simulator.
 */
export function buildDemoModel(options: BuildDemoOptions = {}): DashboardModel {
  const persona = getPersona(options.persona);
  const quotes = tickQuotes(persona.quotes, options.tick ?? 0);
  return buildDashboard(persona.export, quotes, persona.fx, DEMO_NOW, null, {
    fxPrevEurUsd: persona.fxPrevEurUsd,
    fxEurUsdSource: "live",
  });
}

// ---------------------------------------------------------------------------
// Deep-link parsing
// ---------------------------------------------------------------------------

/** Tab ids the demo deep link may target (mirrors the dashboard tab bar). */
export const DEMO_TAB_IDS = ["overview", "periods", "analytics", "plan"] as const;
export type DemoTabId = (typeof DEMO_TAB_IDS)[number];

export interface DemoParams {
  /** Whether demo/preview mode was requested at all. */
  requested: boolean;
  /** Resolved persona id (always a valid id when {@link requested}). */
  persona: string;
  /** Tab to open on entry, or null to use the remembered tab. */
  tab: DemoTabId | null;
  /** Whether to auto-start the guided tour. */
  tour: boolean;
  /** Whether to start in live-sim (moving) mode rather than frozen. */
  sim: boolean;
}

function truthyFlag(value: string | null): boolean {
  if (value === null) return false;
  const v = value.toLowerCase();
  return v === "" || v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Parse the demo deep-link from a URL query string (e.g. `?demo=tech&tab=risk`).
 *
 * Recognises `?demo` and the `?preview` alias. `demo`/`preview` may also name a
 * persona directly (`?demo=tech`). `tab` accepts the tab id or the friendly
 * "risk"/"calculator" aliases. `tour`/`sim` are boolean-ish flags. All inputs
 * are validated and clamped to known values so a malformed link can never do
 * anything but fall back to the default persona/overview.
 */
export function parseDemoParams(search: string): DemoParams {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  const requested = params.has("demo") || params.has("preview");
  const rawPersona = params.get("demo") ?? params.get("preview") ?? "";
  const persona = getPersona(rawPersona).id;

  const rawTab = (params.get("tab") ?? "").toLowerCase();
  const tabAlias = rawTab === "risk" ? "analytics" : rawTab === "calculator" ? "plan" : rawTab;
  const tab = (DEMO_TAB_IDS as readonly string[]).includes(tabAlias) ? (tabAlias as DemoTabId) : null;

  return {
    requested,
    persona,
    tab,
    tour: truthyFlag(params.get("tour")),
    sim: truthyFlag(params.get("sim")),
  };
}
