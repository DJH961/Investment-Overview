import type { DollarDto, ScenariosDto } from "../lib/queries/currencyDollar";
import { scaledDailyRates } from "./rateHistory";

const money = (n: number) => n.toFixed(2);
const rateValue = (usdPerEur: number) => ({ rate: usdPerEur.toFixed(5), inverse: (1 / usdPerEur).toFixed(5) });
const rateChange = (ratePct: number, inversePct: number) => ({ rate_pct: ratePct.toFixed(5), inverse_pct: inversePct.toFixed(5) });

/** Full synthetic Dollar endpoint pair for the page's fixtures mode. */
export function currencyDollarFixture(range: string, now = 1.16): Record<"EUR" | "USD", DollarDto> {
  const EUR = makeDollar("EUR", range, now);
  const USD = makeDollar("USD", range, now);
  return { EUR, USD };
}

function makeDollar(ccy: "EUR" | "USD", range: string, now: number): DollarDto {
  const rates = scaledDailyRates(now);
  const tail = rates.slice(-366);
  const points = tail.filter((_, i) => i % 10 === 0 || i === tail.length - 1).map((p, i, all) => ({
    t: `${p.day}T00:00:00Z`,
    rate_pct: ((p.rate / all[Math.max(0, i - 1)].rate - 1) * 100).toFixed(4),
    inverse_pct: ((all[Math.max(0, i - 1)].rate / p.rate - 1) * 100).toFixed(4),
  }));
  const exposure = 136_450.5;
  const current = rateValue(now);
  const average = rateValue(1.105);
  const breakeven = rateValue(1.09);
  const low = rateValue(1.02);
  const high = rateValue(1.24);
  const trend = {
    regime: { direction: "dollar_down", since: "2026-08-14", since_change_pct: "-0.0320" },
    ma200: { side: "below", ma200: current, distance_pct: "-0.0180", slope: "falling" },
    normal_month: { window: "month", move_pct: "-0.0060", normal_limit_pct: "0.0210", typical_move_pct: "0.0110", label: "normal" },
    normal_year: { window: "year", move_pct: "-0.0280", normal_limit_pct: "0.0840", typical_move_pct: "0.0460", label: "normal" },
    percentiles: { since_start: "0.58", y5: "0.63", y10: "0.55", since_1999: "0.61" },
    week52: { low, high, from_high_inverse_pct: "-0.0645", from_low_inverse_pct: "0.0750" },
    run: { direction: "fell", count: 4, of: 6, unit: "month" },
    long_run: { mean: rateValue(1.12), distance_inverse_pct: "0.0345", since: "1999-01-04" },
    above_entry_share: "0.57",
  };
  const rolling = (["1m", "3m", "1y"] as const).map((window, j) => ({
    window,
    normal_limit_pct: ["0.0210", "0.0380", "0.0840"][j],
    points: points.map((p) => ({ ...p, t: p.t })),
  }));
  return {
    ccy,
    range: range as DollarDto["range"],
    as_of: "2026-11-20",
    generated_at: "2026-11-20T22:10:00Z",
    quote: { field: ccy === "EUR" ? "inverse" : "rate", pair: ccy === "EUR" ? "USD/EUR" : "EUR/USD" },
    caption: "Exchange rates wander and tend to revert over years; this page describes, it does not predict.",
    position: {
      exposure_usd: money(exposure),
      exposure_value: money(exposure / now),
      exposure_share: "0.37",
      avg_rate: average,
      rate_now: current,
      change: rateChange(0.0498, -0.0474),
      today: rateChange(-0.0034, 0.0034),
      fx_gain_eur: "8240.55",
      breakeven,
    },
    next_euro: { amount_eur: "1000.00", usd_now: money(now * 1000), usd_year_ago: "1088.30", change_pct: "0.0658", better_than_share: "0.59" },
    trend,
    rolling,
    stats: [
      { key: "low_since_start", value: "0.987", value_display: null, unit: "rate", currency: null, date: "2020-03-20" },
      { key: "high_since_start", value: "1.245", value_display: null, unit: "rate", currency: null, date: "2021-01-06" },
      { key: "avg_rate_holding", value: "1.105", value_display: null, unit: "rate", currency: null, date: null },
      { key: "share_above_avg", value: "0.57", value_display: null, unit: "fraction", currency: null, date: null },
      { key: "rate_volatility", value: "0.081", value_display: null, unit: "fraction", currency: null, date: null },
    ],
  } as unknown as DollarDto;
}

/** Full synthetic scenario pair with server-shaped rows and marker positions. */
export function currencyScenariosFixture(now = 1.16): Record<"EUR" | "USD", ScenariosDto> {
  return { EUR: makeScenarios("EUR", now), USD: makeScenarios("USD", now) };
}

function makeScenarios(ccy: "EUR" | "USD", now: number): ScenariosDto {
  const usdHoldings = 136_450.5;
  const usdValue = 78_320;
  const rates = Array.from({ length: 15 }, (_, i) => 0.9 + i * 0.05);
  const rows = rates.map((r) => {
    const value = ccy === "EUR" ? usdHoldings / r : usdValue * (1 + (now - r) * 0.7);
    const base = ccy === "EUR" ? usdHoldings / 1.09 : usdValue;
    const gain = value - base;
    return { rate: r.toFixed(4), rate_display: r.toFixed(4), value: money(value), gain: money(gain), to_breakeven: (r - 1.09).toFixed(4), to_breakeven_pct: (r / 1.09 - 1).toFixed(5) };
  });
  const nearest = (r: number) => rates.reduce((best, v, i) => Math.abs(v - r) < Math.abs(rates[best] - r) ? i : best, 0);
  return {
    ccy,
    as_of: "2026-11-20",
    generated_at: "2026-11-20T22:10:00Z",
    quote: { field: ccy === "EUR" ? "inverse" : "rate", pair: ccy === "EUR" ? "USD/EUR" : "EUR/USD" },
    caption: "Exchange rates wander and tend to revert over years; this page describes, it does not predict.",
    step: "0.0500",
    min_rate: "0.9000",
    max_rate: "1.6000",
    rate_now: { rate: now.toFixed(5), inverse: (1 / now).toFixed(5) },
    value_now: money(ccy === "EUR" ? usdHoldings / now : usdValue),
    avg_rate: { rate: "1.10500", inverse: (1 / 1.105).toFixed(5) },
    breakeven: { rate: "1.09000", inverse: (1 / 1.09).toFixed(5) },
    rows,
    marks: [
      { key: "historic_low", rate: "1.0200", rate_display: "1.0200", row_index: nearest(1.02), date: "2020-03-20" },
      { key: "breakeven", rate: "1.0900", rate_display: "1.0900", row_index: nearest(1.09), date: null },
      { key: "average", rate: "1.1050", rate_display: "1.1050", row_index: nearest(1.105), date: null },
      { key: "today", rate: now.toFixed(4), rate_display: now.toFixed(4), row_index: nearest(now), date: "2026-11-20" },
      { key: "historic_high", rate: "1.2400", rate_display: "1.2400", row_index: nearest(1.24), date: "2021-01-06" },
    ],
    sensitivity: { rate: now.toFixed(4), value_at_rate: money(ccy === "EUR" ? usdHoldings / now : usdValue), value_at_rate_plus: money(ccy === "EUR" ? usdHoldings / (now + 0.01) : usdValue + 500), change: ccy === "EUR" ? "-1169.73" : "500.00" },
    cushion: { since: "2019-03-04", volatility_eur: "0.1420", volatility_usd: "0.1570", max_drawdown_eur: "-0.2430", max_drawdown_usd: "-0.2850", down_days: 119, down_days_dollar_rose: 48, dollar_rose_share: "0.4034" },
    stress: [-0.2, -0.1, 0, 0.1, 0.2].map((shift) => ({ shift_pct: shift.toFixed(3), rate: (now * (1 + shift)).toFixed(4), rate_display: (now * (1 + shift)).toFixed(4), value: money(ccy === "EUR" ? usdHoldings / (now * (1 + shift)) : usdValue), change: money(ccy === "EUR" ? usdHoldings / (now * (1 + shift)) - usdHoldings / now : usdValue * shift) })),
    stats: [
      { key: "one_cent", value: "1170", unit: "money", currency: ccy, secondary: null, secondary_unit: null },
      { key: "breakeven", value: "1.0900", unit: "rate", currency: null, secondary: "0.0600", secondary_unit: "rate" },
      { key: "value_at_low", value: rows[nearest(1.02)].value, unit: "money", currency: ccy, secondary: null, secondary_unit: null },
      { key: "value_at_high", value: rows[nearest(1.24)].value, unit: "money", currency: ccy, secondary: null, secondary_unit: null },
      { key: "volatility", value: "0.1420", unit: "fraction", currency: null, secondary: "0.1570", secondary_unit: "fraction" },
      { key: "deepest_fall", value: "-0.2430", unit: "fraction", currency: null, secondary: "-0.2850", secondary_unit: "fraction" },
      { key: "dollar_rose_on_down_days", value: "0.4034", unit: "fraction", currency: null, secondary: null, secondary_unit: null },
    ],
  } as unknown as ScenariosDto;
}
