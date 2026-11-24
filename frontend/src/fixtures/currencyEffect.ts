/**
 * Synthetic `GET /api/currency/effect/both?range=` for fixture mode, until the recorder
 * writes the real endpoint. Invented data, never market or ledger data: a dollar book
 * and a small euro sleeve, fed by the fixture's euro deposits (`depositSchedule`), moved
 * by a seeded market walk and by the same EUR/USD walk the rate chart draws. Each side
 * is built in its own currency from native amounts, the way the server does it:
 *
 * - EUR view: currency part `N_pre * (1/r_t - 1/r_{t-1})` on the dollars held, market
 *   part the rest; deposits in euros.
 * - USD view: currency part `E_pre * (r_t - r_{t-1})` on the euros held; deposits at
 *   their own day's rate.
 *
 * Every identity holds: start + deposits + market + currency = end; months sum to the
 * range's effect; inside + outside = covered.
 */
import { depositSchedule, intradayRates, PORTFOLIO_START, scaledDailyRates } from "./rateHistory";

type Ccy = "EUR" | "USD";
type Kind = "tailwind" | "headwind" | "neutral";
type Obj = Record<string, unknown>;

const DAY = 86_400_000;
const EUR_SHARE = 0.03; // share of each deposit kept in euro instruments

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One business day of the model, per side: value, flow, market and currency parts. */
interface Day {
  day: string;
  rate: number;
  N: number; // dollar book, USD native, after the day's deposit
  E: number; // euro sleeve, EUR native
  side: Record<Ccy, { value: number; flow: number; market: number; currency: number }>;
}

let cache: { key: string; days: Day[] } | null = null;

function model(now: number, scale: number): Day[] {
  const key = `${now}|${scale}`;
  if (cache?.key === key) return cache.days;
  const rates = scaledDailyRates(now).filter((p) => p.day >= PORTFOLIO_START);
  const deposits = new Map(depositSchedule(rates).map((d) => [d.day, d.eur * scale]));
  const rnd = mulberry32(7202);
  const noise = () => rnd() + rnd() + rnd() - 1.5; // ~N(0, 0.5)
  const days: Day[] = [];
  let N = 0;
  let E = 0;
  let prevRate = rates[0].rate;
  for (const p of rates) {
    const common = noise();
    const mUsd = 0.00031 + 0.0205 * common;
    const mEur = 0.00024 + 0.016 * (0.7 * common + 0.3 * noise());
    const nPre = N * Math.exp(mUsd);
    const ePre = E * Math.exp(mEur);
    const f = deposits.get(p.day) ?? 0;
    const eur = {
      flow: f,
      market: (nPre - N) / prevRate + (ePre - E),
      currency: nPre * (1 / p.rate - 1 / prevRate),
    };
    const usd = {
      flow: f * p.rate,
      market: nPre - N + (ePre - E) * prevRate,
      currency: ePre * (p.rate - prevRate),
    };
    N = nPre + f * (1 - EUR_SHARE) * p.rate;
    E = ePre + f * EUR_SHARE;
    days.push({
      day: p.day,
      rate: p.rate,
      N,
      E,
      side: { EUR: { value: N / p.rate + E, ...eur }, USD: { value: N + E * p.rate, ...usd } },
    });
    prevRate = p.rate;
  }
  cache = { key, days };
  return days;
}

/** Scale that makes the fixture book end at the recorded total value (deposits scale with it). */
export function effectScale(now: number, totalEur: number): number {
  const days = model(now, 1);
  const end = days[days.length - 1].side.EUR.value;
  return end > 0 && totalEur > 0 ? totalEur / end : 1;
}

const kindOf = (v: number): Kind => (Math.abs(v) < 0.5 ? "neutral" : v > 0 ? "tailwind" : "headwind");
const s = (v: number, d = 2) => v.toFixed(d);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Index of the close a range starts from (-1: before the first day, value 0). */
function startIndex(days: Day[], range: string): number {
  const last = days[days.length - 1].day;
  const lastT = Date.parse(`${last}T00:00:00Z`);
  let from: string;
  if (/^\d{4}$/.test(range)) from = `${range}-01-01`;
  else if (range === "ytd") from = `${last.slice(0, 4)}-01-01`;
  else if (range === "all") return -1;
  else {
    const back = { "1d": 1, "1w": 7, "1m": 31, "3m": 92, "1y": 366, "3y": 3 * 366 }[range] ?? 366;
    from = iso(lastT - back * DAY);
  }
  // The last close strictly before the range's first day.
  let i = -1;
  for (let k = 0; k < days.length; k++) if (days[k].day < from) i = k;
  return range === "1d" ? days.length - 2 : i;
}

function endIndex(days: Day[], range: string): number {
  if (!/^\d{4}$/.test(range)) return days.length - 1;
  let i = days.length - 1;
  for (let k = 0; k < days.length; k++) if (days[k].day <= `${range}-12-31`) i = k;
  return i;
}

function chainReturn(days: Day[], from: number, to: number, c: Ccy): number {
  let g = 1;
  for (let k = Math.max(from + 1, 1); k <= to; k++) {
    const prev = days[k - 1].side[c].value;
    if (prev > 0) g *= 1 + (days[k].side[c].market + days[k].side[c].currency) / prev;
  }
  return g - 1;
}

function groupSum(rows: { key: string; v: number }[]): { key: string; v: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + r.v);
  return [...m.entries()].map(([key, v]) => ({ key, v }));
}

interface HoldingSeed {
  instrument_id: number;
  symbol: string;
  name: string | null;
  native_ccy: string;
  weight: number;
  dividendShare: number;
}

function holdingSeeds(data: Obj): HoldingSeed[] {
  const both = data["GET /api/holdings/both"] as { EUR?: { holdings?: Obj[] } } | undefined;
  const rows = (both?.EUR?.holdings ?? []).filter((h) => Number(h.value) > 0);
  const total = rows.reduce((a, h) => a + Number(h.value), 0) || 1;
  const divTotal = rows.reduce((a, h) => a + Math.max(0, Number(h.dividends ?? 0)), 0) || 1;
  return rows.map((h) => ({
    instrument_id: Number(h.instrument_id),
    symbol: String(h.symbol),
    name: (h.name as string | null) ?? null,
    native_ccy: String(h.native_currency ?? "USD"),
    weight: Number(h.value) / total,
    dividendShare: Math.max(0, Number(h.dividends ?? 0)) / divTotal,
  }));
}

function holdings(seeds: HoldingSeed[], c: Ccy, market: number, currency: number, years: number, avgValue: number): Obj[] {
  const rnd = mulberry32(31 + Math.round(years * 100));
  const dividends = avgValue * 0.009 * years;
  // Only the holdings in the other currency carry the currency effect of this side.
  const foreign = seeds.filter((h) => h.native_ccy !== c);
  const fw = foreign.reduce((a, h) => a + h.weight, 0) || 1;
  const tilt = seeds.map(() => 0.6 + 0.8 * rnd());
  const tw = seeds.reduce((a, h, i) => a + h.weight * tilt[i], 0) || 1;
  return seeds.map((h, i) => {
    const cur = h.native_ccy !== c ? (currency * h.weight) / fw : 0;
    const div = dividends * h.dividendShare;
    const price = ((market - dividends) * h.weight * tilt[i]) / tw;
    return {
      instrument_id: h.instrument_id,
      symbol: h.symbol,
      name: h.name,
      native_ccy: h.native_ccy,
      price: s(price),
      dividends: s(div),
      currency: s(cur),
      total: s(price + div + cur),
    };
  });
}

type Parts = { series: Obj[]; currency: number; market: number; end: number; own: number };

/**
 * 1D / 1W: the book held at the start close, revalued along the intraday rate, plus a
 * small seeded market walk (dollar prices; the euro sleeve moves with them).
 */
function intradayParts(days: Day[], intraday: { t: string; rate: number }[], range: string): Record<Ccy, Parts> {
  const base = days[startIndex(days, range)] ?? days[days.length - 2];
  const r0 = intraday[0].rate;
  const rnd = mulberry32(range === "1d" ? 5 : 9);
  let g = 1;
  const rows = intraday.map((p) => {
    g *= 1 + 0.0011 * (rnd() - 0.46);
    return { t: p.t, rate: p.rate, g };
  });
  const build = (c: Ccy): Parts => {
    const start = base.side[c].value;
    const series = rows.map((p) => {
      const n = base.N * p.g;
      const e = base.E * p.g;
      const value = c === "EUR" ? n / p.rate + e : n + e * p.rate;
      const cur = c === "EUR" ? n * (1 / p.rate - 1 / r0) : e * (p.rate - r0);
      return { t: p.t, value, cur };
    });
    const last = series[series.length - 1];
    return {
      series: series.map((p) => ({ t: p.t, value: s(p.value), constant_currency: s(p.value - p.cur), currency: s(p.cur) })),
      currency: last.cur,
      market: last.value - start - last.cur,
      end: last.value,
      own: start > 0 ? last.value / start - 1 : 0,
    };
  };
  return { EUR: build("EUR"), USD: build("USD") };
}

function stat(key: string, value: number, unit: string, c: Ccy | null, extra: Obj = {}): Obj {
  return { key, value: s(value, unit === "money" ? 2 : 6), unit, currency: c, ...extra };
}

function side(c: Ccy, days: Day[], range: string, seeds: HoldingSeed[], intraday: { t: string; rate: number }[] | null): Obj {
  const other: Ccy = c === "EUR" ? "USD" : "EUR";
  const from = startIndex(days, range);
  const to = endIndex(days, range);
  const startValue = from >= 0 ? days[from].side[c].value : 0;
  const lastClose = days[to];
  const inRange = days.slice(from + 1, to + 1);
  const helpWord = c === "EUR" ? "dollar" : "euro";

  // --- the range's parts -------------------------------------------------------------
  let series: Obj[];
  let deposits: number;
  let market: number;
  let currency: number;
  let end: number;
  let eurReturn: number;
  let usdReturn: number;
  if (intraday && intraday.length > 1) {
    const parts = intradayParts(days, intraday, range);
    series = parts[c].series;
    currency = parts[c].currency;
    market = parts[c].market;
    end = parts[c].end;
    deposits = 0;
    // Each side's return on its own stream.
    eurReturn = parts.EUR.own;
    usdReturn = parts.USD.own;
  } else {
    let cum = 0;
    const weekly = range === "all" || range === "3y";
    series = inRange
      .map((d, i) => {
        cum += d.side[c].currency;
        const keep = !weekly || i === inRange.length - 1 || new Date(`${d.day}T00:00:00Z`).getUTCDay() === 5;
        return keep ? { t: d.day, value: s(d.side[c].value), constant_currency: s(d.side[c].value - cum), currency: s(cum) } : null;
      })
      .filter((p): p is { t: string; value: string; constant_currency: string; currency: string } => p !== null);
    deposits = inRange.reduce((a, d) => a + d.side[c].flow, 0);
    market = inRange.reduce((a, d) => a + d.side[c].market, 0);
    currency = inRange.reduce((a, d) => a + d.side[c].currency, 0);
    end = lastClose.side[c].value;
    eurReturn = chainReturn(days, from, to, "EUR");
    usdReturn = chainReturn(days, from, to, "USD");
  }
  // EUR return minus USD return, each on its own stream.
  const pp = eurReturn - usdReturn;
  const share = Math.abs(market) + Math.abs(currency) > 0 ? Math.abs(currency) / (Math.abs(market) + Math.abs(currency)) : null;

  // --- months, years, grid, rolling, run, records (daily ranges) -----------------------
  const daily = intraday ? [] : inRange;
  const months = groupSum(daily.map((d) => ({ key: d.day.slice(0, 7), v: d.side[c].currency }))).map((m) => ({
    label: m.key,
    currency: s(m.v),
    kind: kindOf(m.v),
  }));
  const years = groupSum(daily.map((d) => ({ key: d.day.slice(0, 4), v: d.side[c].currency }))).map((y) => ({
    label: y.key,
    currency: s(y.v),
    kind: kindOf(y.v),
  }));
  const grid = years.map((y) => {
    const cells: (string | null)[] = Array.from({ length: 12 }, (_, i) => {
      const m = months.find((x) => x.label === `${y.label}-${String(i + 1).padStart(2, "0")}`);
      return m ? m.currency : null;
    });
    return { year: Number(y.label), months: cells, total: y.currency, kind: y.kind };
  });
  // Rolling 252 business days over the whole life, the points inside the range.
  const rolling: Obj[] = [];
  if (!intraday) {
    let acc = 0;
    const weekly = range === "all" || range === "3y";
    days.forEach((d, k) => {
      acc += d.side[c].currency;
      if (k >= 252) acc -= days[k - 252].side[c].currency;
      if (k < 252 || k <= from || k > to) return;
      if (weekly && new Date(`${d.day}T00:00:00Z`).getUTCDay() !== 5 && k !== to) return;
      rolling.push({ t: d.day, currency: s(acc) });
    });
  }
  // The current streak of same-sign months, lifetime.
  const life = groupSum(days.map((d) => ({ key: d.day.slice(0, 7), v: d.side[c].currency })));
  let run: Obj | null = null;
  {
    const lastSign = Math.sign(life[life.length - 1]?.v ?? 0);
    let n = 0;
    let sum = 0;
    for (let k = life.length - 1; k >= 0 && Math.sign(life[k].v) === lastSign && lastSign !== 0; k--) {
      n++;
      sum += life[k].v;
    }
    if (n > 0) {
      const helped = lastSign > 0;
      const since = life[life.length - n].key;
      run = {
        kind: helped ? "tailwind" : "headwind",
        months: n,
        since,
        currency: s(sum),
        statement: `The ${helpWord} has ${helped ? "helped" : "held you back"} ${n} ${n === 1 ? "month" : "months"} running.`,
      };
    }
  }
  const pick = (rows: { key: string; v: number }[], best: boolean) =>
    rows.length ? rows.reduce((a, b) => (best ? (b.v > a.v ? b : a) : b.v < a.v ? b : a)) : null;
  const rec = (r: { key: string; v: number } | null) => (r ? { label: r.key, currency: s(r.v) } : null);
  const dayRows = daily.map((d) => ({ key: d.day, v: d.side[c].currency }));
  const monthRows = months.map((m) => ({ key: m.label, v: Number(m.currency) }));
  const yearRows = years.map((y) => ({ key: y.label, v: Number(y.currency) }));
  const lifetimeEffect = days.reduce((a, d) => a + d.side[c].currency, 0);
  const lifeDeposits = days.reduce((a, d) => a + d.side[c].flow, 0);
  const avgMonthly = lifeDeposits / Math.max(1, life.length);
  const records = {
    best_day: rec(pick(dayRows, true)),
    worst_day: rec(pick(dayRows, false)),
    best_month: monthRows.length > 1 ? rec(pick(monthRows, true)) : null,
    worst_month: monthRows.length > 1 ? rec(pick(monthRows, false)) : null,
    best_year: yearRows.length > 1 ? rec(pick(yearRows, true)) : null,
    worst_year: yearRows.length > 1 ? rec(pick(yearRows, false)) : null,
    lifetime_effect: s(lifetimeEffect),
    average_monthly_contribution: s(avgMonthly),
    lifetime_months_of_contributions: s(lifetimeEffect / avgMonthly, 4),
  };

  // --- per holding, session split, buys ------------------------------------------------
  const spanYears = Math.max(1 / 252, (intraday ? 1 : Math.max(1, inRange.length)) / 252);
  const avgValue = (startValue + end) / 2 || end;
  const hold = holdings(seeds, c, market, currency, spanYears, avgValue);

  let sessionSplit: Obj | null = null;
  let buys: Obj | null = null;
  if (intraday) {
    // Session rates recorded from three sessions ago: the 1W split covers part of the week.
    const recordedFrom = days[days.length - 3].day;
    const firstDay = String(series[0].t).slice(0, 10);
    const uncoveredShare = range === "1w" && firstDay < recordedFrom ? 0.42 : 0;
    const covered = currency * (1 - uncoveredShare);
    const inside = covered * 0.38;
    sessionSplit = {
      inside: s(inside),
      outside: s(covered - inside),
      covered_currency: s(covered),
      uncovered_currency: s(currency - covered),
      available_from: recordedFrom,
      note: uncoveredShare > 0 ? `Split not available before ${recordedFrom}` : null,
    };
    const rNow = intraday[intraday.length - 1].rate;
    const rPrev = days[days.length - 2].rate;
    buys = {
      amount_eur: "1000",
      usd_now: s(1000 * rNow),
      usd_prev: s(1000 * rPrev),
      change_usd: s(1000 * (rNow - rPrev)),
      market_hours_usd: s(1000 * (rNow - rPrev) * 0.4),
      overnight_usd: s(1000 * (rNow - rPrev) * 0.6),
    };
  }

  const stats: Obj[] = [];
  if (!intraday && monthRows.length > 1) {
    const helped = monthRows.filter((m) => m.v > 0).length;
    stats.push(stat("tailwind_share", helped / monthRows.length, "fraction", null, { secondary: String(monthRows.length), secondary_unit: "count" }));
  }
  if (dayRows.length > 5) {
    const abs = dayRows.map((d) => Math.abs(d.v)).sort((a, b) => a - b);
    stats.push(stat("typical_day", abs[Math.floor(abs.length / 2)], "money", c));
    const big = dayRows.reduce((a, b) => (Math.abs(b.v) > Math.abs(a.v) ? b : a));
    stats.push(stat("largest_day", big.v, "money", c, { label: big.key, kind: kindOf(big.v) }));
  }
  if (range === "all") stats.push(stat("months_of_contributions", lifetimeEffect / avgMonthly, "count", null));

  return {
    ccy: c,
    range,
    as_of: lastClose.day,
    generated_at: new Date().toISOString().slice(0, 19),
    start_on: from >= 0 ? days[from].day : days[0].day,
    end_on: lastClose.day,
    granularity: intraday ? "intraday" : range === "all" || range === "3y" ? "weekly" : "daily",
    headline: {
      eur_return: s(eurReturn, 6),
      usd_return: s(usdReturn, 6),
      effect_pp: s(pp, 6),
      effect: s(currency),
      market: s(market),
      currency_share: share === null ? null : s(share, 4),
      kind: kindOf(currency),
      return_basis: intraday ? "day" : range === "ytd" || /^\d{4}$/.test(range) || range === "all" ? "periods" : "daily_chain",
    },
    series,
    bridge: {
      start_on: from >= 0 ? days[from].day : days[0].day,
      end_on: lastClose.day,
      start: s(startValue),
      deposits: s(deposits),
      market: s(market),
      currency: s(currency),
      end: s(startValue + deposits + market + currency),
    },
    months: intraday ? [] : months,
    years: intraday ? [] : years,
    grid: intraday ? [] : grid,
    rolling,
    rolling_window_days: 252,
    run,
    records,
    holdings: hold,
    session_split: sessionSplit,
    buys: c === "EUR" || c === "USD" ? buys : null,
    stats,
    explainer:
      range === "all"
        ? `Day by day: each rate move counts only on the ${other === "USD" ? "euros" : "dollars"} you held that day. The Overview's lifetime figure compares today's rate with your average buying rate instead, so the two differ.`
        : null,
  };
}

export function currencyEffectFixture(range: string, opts: { now: number; scale: number; data: Obj }): unknown {
  const days = model(opts.now, opts.scale);
  const seeds = holdingSeeds(opts.data);
  const intraday = range === "1d" || range === "1w" ? intradayRates(range, opts.now) : null;
  return { EUR: side("EUR", days, range, seeds, intraday), USD: side("USD", days, range, seeds, intraday) };
}
