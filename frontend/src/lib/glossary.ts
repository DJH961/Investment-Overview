/** Plain-language definitions shared by the Risk tooltips and the Help glossary. */
export interface GlossaryEntry {
  key: string;
  term: string;
  definition: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { key: "cagr", term: "CAGR", definition: "Compound annual growth rate: the steady yearly rate of the time-weighted return, so deposits and withdrawals do not count as growth. Under a year invested it is the plain growth, not annualised." },
  { key: "twr", term: "TWR", definition: "Time-weighted return. Chains the return of each sub-period so the size and timing of your deposits do not matter. Use it to judge the investments themselves." },
  { key: "xirr", term: "XIRR", definition: "Money-weighted annualised return. Takes the size and date of every deposit and withdrawal into account, so it reflects your own timing." },
  { key: "volatility", term: "Volatility", definition: "Annualised standard deviation of daily returns. Higher means a bumpier ride." },
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
  { key: "attribution", term: "Attribution", definition: "How much each holding added to or took from the total return. Net added is the money you put in during the period." },
  { key: "capital_gain", term: "Capital gain", definition: "Realised plus unrealised price gain after fees, with no dividends in it: total return minus dividend income. Includes gains locked in by selling and money held in cash or savings." },
  { key: "unrealised_gain", term: "Unrealised gain", definition: "Value minus cost basis of what you still hold, without dividends. It is the part of the capital gain that is not yet locked in by a sale." },
  { key: "total_return", term: "Total return", definition: "Capital gain plus dividend income (cash and reinvested), after fees, for the whole portfolio including sold positions. Same number on Overview and Holdings." },
  { key: "net_invested", term: "Net invested", definition: "Deposits minus withdrawals to date." },
];

const BY_KEY = new Map(GLOSSARY.map((g) => [g.key, g]));

export function glossaryText(key: string): string {
  return BY_KEY.get(key)?.definition ?? "";
}
