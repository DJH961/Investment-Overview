/** Plain-language definitions shared by the Risk tooltips and the Help glossary. */
export interface GlossaryEntry {
  key: string;
  term: string;
  definition: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { key: "cagr", term: "CAGR", definition: "Compound annual growth rate: the steady yearly rate of the time-weighted return, so deposits and withdrawals do not count as growth. Under a year invested it is the plain growth, not annualized." },
  { key: "twr", term: "TWR", definition: "Time-weighted return. Chains the return of each sub-period so the size and timing of your deposits do not matter. Use it to judge the investments themselves. It is not the Overview's Total growth, which is money-weighted: (1 + XIRR) to the power of the years held, minus 1." },
  { key: "xirr", term: "XIRR", definition: "Money-weighted annualized return. Takes the size and date of every deposit and withdrawal into account, so it reflects your own timing." },
  { key: "volatility", term: "Volatility", definition: "Annualized standard deviation of daily returns. Higher means a bumpier ride." },
  { key: "sharpe", term: "Sharpe ratio", definition: "Return above the risk-free rate per unit of volatility. Above 1 is generally good; negative means you earned less than the risk-free rate." },
  { key: "sortino", term: "Sortino ratio", definition: "Like Sharpe, but only downside volatility counts as risk." },
  { key: "max_drawdown", term: "Max drawdown", definition: "The largest peak-to-trough fall in the period." },
  { key: "calmar", term: "Calmar ratio", definition: "Annual return divided by the maximum drawdown." },
  { key: "ulcer", term: "Ulcer index", definition: "Combines the depth and the duration of drawdowns. Lower is calmer." },
  { key: "var_95", term: "VaR (95%)", definition: "Value at risk: the daily loss that was exceeded on only 5% of days." },
  { key: "cvar_95", term: "CVaR (95%)", definition: "Expected shortfall: the average daily loss on the worst 5% of days." },
  { key: "beta", term: "Beta", definition: "Sensitivity to the benchmark. 1 moves with it, below 1 moves less." },
  { key: "alpha", term: "Alpha", definition: "Return beyond what beta to the benchmark explains." },
  { key: "skew", term: "Skew", definition: "Asymmetry of daily returns. Negative means large losses are more likely than large gains." },
  { key: "kurtosis", term: "Excess kurtosis", definition: "Tail heaviness versus a normal distribution. Positive means more extreme days than expected." },
  { key: "risk_free", term: "Risk-free rate", definition: "The return on a very safe asset (a short-term government rate). Sharpe and Sortino measure your return above it." },
  { key: "benchmark", term: "Benchmark (funded)", definition: "A reference index fed with the same deposits on the same dates as your portfolio, so the comparison is fair. The gap shows how far ahead or behind you are." },
  { key: "attribution", term: "Attribution", definition: "How much each holding added to or took from the total return. Net added is the money moved into a holding during the period (cash dividends it paid out count as money moved out). Money-market funds and cash count only what they earned. P&L = End − Start − Net added." },
  { key: "capital_gain", term: "Capital gain", definition: "Realized plus unrealized price gain after fees, with no dividends in it: total return minus dividend income. Includes gains locked in by selling and money held in cash or savings." },
  { key: "unrealised_gain", term: "Unrealized gain", definition: "Value minus cost basis of what you still hold, without dividends. It is the part of the capital gain that is not yet locked in by a sale." },
  { key: "total_return", term: "Total return", definition: "Capital gain plus dividend income (cash and reinvested), after fees, for the whole portfolio including sold positions. Same number on Overview and Holdings." },
  { key: "net_invested", term: "Net invested", definition: "Deposits minus withdrawals to date." },
  { key: "your_rate", term: "Your rate", definition: "The blended EUR/USD exchange rate you actually paid for the dollars you still hold, weighted across your conversions with fees counted in." },
  { key: "conversion_cost", term: "Conversion cost", definition: "What converting between euros and dollars cost against the ECB daily reference rate of that day: provider fees plus the rate spread, both ways." },
  { key: "waiting", term: "Waiting", definition: "What the exchange rate moved while converted dollars sat in your USD account between the conversion and the broker deposit." },
  { key: "realised_fx", term: "Realized FX", definition: "The exchange-rate gain or loss locked in when dollars are converted back to euros, measured against the euros that originally bought those dollars." },
  { key: "unrealised_fx", term: "Unrealized FX", definition: "The exchange-rate gain or loss on dollars you still hold in your USD account, broker cash, or investments, measured against what those dollars cost you. It becomes realized only when you convert back to euros." },
];

const BY_KEY = new Map(GLOSSARY.map((g) => [g.key, g]));

export function glossaryText(key: string): string {
  return BY_KEY.get(key)?.definition ?? "";
}
