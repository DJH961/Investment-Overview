/**
 * Synthetic answers for the v7.2 "The dollar" / "What if" endpoints, the Projection rate
 * band (P5) and the allocation currency split, for fixture mode until the recorder
 * writes them. Built on the synthetic rate walk of `./rateHistory` and the recorded
 * Overview / holdings figures, so the cards agree with the rest of the fixture app.
 * Invented data with a plausible shape: never market or ledger data.
 */

import { rateHistoryFixture } from "./rateHistory";

type Obj = Record<string, unknown>;
type Pt = { t: string; rate: string; inverse: string };
type RH = { points: Pt[]; trend: Obj; percentiles: Obj };

const f = (v: number, d = 6) => v.toFixed(d);
const rv = (rate: number) => ({ rate: f(rate, 5), inverse: f(1 / rate, 6) });
const change = (start: number, end: number) => ({
  start_rate: f(start, 5),
  end_rate: f(end, 5),
  rate_pct: f(end / start - 1),
  inverse_pct: f(start / end - 1),
});
const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Obj)[k] : undefined), o);
const num = (v: unknown, fallback: number) => (v === null || v === undefined || Number.isNaN(Number(v)) ? fallback : Number(v));

interface Book {
  now: number;
  avg: number;
  breakeven: number;
  prev: number;
  fxGainEur: number;
  /** Holdings priced in dollars, native USD. */
  usd: number;
  /** Holdings priced in euros, native EUR. */
  eur: number;
  usdShare: number;
}

function book(data: Obj): Book {
  const life = get(data, "GET /api/overview/both", "EUR", "currency", "lifetime");
  const today = get(data, "GET /api/overview/both", "EUR", "currency", "today");
  const now = num(get(life, "current_rate"), 1.16);
  const groups = (get(data, "GET /api/holdings/both?group_by=currency", "USD", "groups") ?? []) as Obj[];
  const eurGroups = (get(data, "GET /api/holdings/both?group_by=currency", "EUR", "groups") ?? []) as Obj[];
  const usd = num(groups.find((g) => g.key === "USD")?.value, 1_450_000);
  const eur = num(eurGroups.find((g) => g.key === "EUR")?.value, 24_000);
  return {
    now,
    avg: num(get(life, "avg_invest_rate"), 1.09),
    breakeven: num(get(life, "breakeven_rate"), 1.09),
    prev: num(get(today, "prev"), now),
    fxGainEur: num(get(life, "fx_pnl_eur"), -100_000),
    usd,
    eur,
    usdShare: num(groups.find((g) => g.key === "USD")?.weight_pct, 0.98),
  };
}

function history(range: string, b: Book): RH {
  return rateHistoryFixture(range, { now: b.now, avg: b.avg }) as RH;
}

/** Trailing change of the rate over `w` points, at every point of `pts` from `from`. */
function rolling(pts: { t: string; r: number }[], w: number, from: string) {
  const out: { t: string; inverse_pct: string; rate_pct: string }[] = [];
  for (let i = w; i < pts.length; i++) {
    if (pts[i].t < from) continue;
    const a = pts[i - w].r;
    const z = pts[i].r;
    out.push({ t: pts[i].t, rate_pct: f(z / a - 1), inverse_pct: f(a / z - 1) });
  }
  return out;
}

const WINDOWS = [
  { window: "1m", days: 21, typical: 0.0152, limit: 0.0262 },
  { window: "3m", days: 63, typical: 0.0274, limit: 0.0468 },
  { window: "1y", days: 252, typical: 0.0611, limit: 0.1035 },
] as const;

/** `GET /api/currency/dollar/both?range=`. */
export function dollarFixture(range: string, data: Obj): unknown {
  const b = book(data);
  const shown = history(range, b);
  const long = range === "10y" || range === "max";
  // Daily history for the windows (5 years back); weekly for 10Y / Max.
  const base = history(long ? range : "5y", b).points.map((p) => ({ t: p.t, r: Number(p.rate) }));
  const step = long ? 5 : 1;
  const from = shown.points[0]?.t.slice(0, 10) ?? base[0].t;
  const daily = history("5y", b).points.map((p) => ({ t: p.t, r: Number(p.rate) }));
  const last = daily[daily.length - 1];
  const at = (back: number) => daily[Math.max(0, daily.length - 1 - back)];
  const month = last.r === 0 ? 0 : at(21).r / last.r - 1;
  const year = at(252).r / last.r - 1;
  const yearRows = daily.slice(-252);
  // EUR/USD low and high (as in rate-history); the dollar lens flips them.
  const lo = yearRows.reduce((a, p) => (p.r < a.r ? p : a));
  const hi = yearRows.reduce((a, p) => (p.r > a.r ? p : a));
  const ma = daily.slice(-200).reduce((a, p) => a + p.r, 0) / 200;
  const maThen = daily.slice(-220, -20).reduce((a, p) => a + p.r, 0) / 200;
  const maxPts = history("max", b).points.map((p) => Number(p.rate));
  const mean = maxPts.reduce((a, v) => a + v, 0) / maxPts.length;
  // The last six calendar months, by their last day: did the dollar fall?
  const ends = new Map<string, number>();
  for (const p of daily) ends.set(p.t.slice(0, 7), p.r);
  const months = [...ends.values()].slice(-7);
  let fell = 0;
  for (let i = 1; i < months.length; i++) if (months[i] > months[i - 1]) fell++;
  const trend = shown.trend;
  const pick = (ccy: "EUR" | "USD") => {
    const eurView = ccy === "EUR";
    const yearAgo = at(252);
    return {
      ccy,
      as_of: last.t,
      generated_at: new Date().toISOString().slice(0, 19),
      range,
      quote: { pair: eurView ? "USD/EUR" : "EUR/USD", field: eurView ? "inverse" : "rate" },
      caption: "Exchange rates wander and tend to revert over years; this page describes, it does not predict.",
      position: {
        exposure_usd: f(b.usd, 2),
        exposure_value: f(eurView ? b.usd / b.now : b.usd, 2),
        exposure_share: f(b.usdShare),
        avg_rate: rv(b.avg),
        rate_now: rv(b.now),
        change: change(b.avg, b.now),
        fx_gain_eur: f(b.fxGainEur, 2),
        breakeven: rv(b.breakeven),
        today: change(b.prev, b.now),
      },
      next_euro: {
        amount_eur: "1000",
        usd_now: f(1000 * b.now, 2),
        usd_year_ago: f(1000 * yearAgo.r, 2),
        year_ago_date: yearAgo.t,
        change_pct: f(b.now / yearAgo.r - 1),
        better_than_share: "0.7130",
      },
      trend: {
        regime: { direction: trend.direction, since: trend.since, since_change_pct: trend.since_change_pct },
        ma200: {
          side: 1 / b.now > 1 / ma ? "above" : "below",
          ma200: rv(ma),
          distance_pct: f(ma / b.now - 1),
          slope: maThen / ma - 1 > 0.002 ? "rising" : maThen / ma - 1 < -0.002 ? "falling" : "flat",
          slope_pct: f(maThen / ma - 1),
          slope_days: 20,
        },
        normal_month: {
          window: "month",
          window_days: 21,
          move_pct: f(month),
          typical_move_pct: "0.0152",
          normal_limit_pct: "0.0262",
          percentile: f(Math.min(0.99, Math.abs(month) / 0.034), 4),
          label: Math.abs(month) > 0.0262 ? (Math.abs(month) > 0.041 ? "unusual" : "large") : "normal",
        },
        normal_year: {
          window: "year",
          window_days: 252,
          move_pct: f(year),
          typical_move_pct: "0.0611",
          normal_limit_pct: "0.1035",
          percentile: f(Math.min(0.99, Math.abs(year) / 0.13), 4),
          label: Math.abs(year) > 0.1035 ? (Math.abs(year) > 0.158 ? "unusual" : "large") : "normal",
        },
        percentiles: shown.percentiles,
        week52: {
          low: { t: lo.t, ...rv(lo.r) },
          high: { t: hi.t, ...rv(hi.r) },
          from_low_inverse_pct: f(lo.r / b.now - 1),
          from_high_inverse_pct: f(hi.r / b.now - 1),
        },
        run: fell >= 3 ? { direction: "fell", count: fell, of: 6 } : { direction: "rose", count: 6 - fell, of: 6 },
        long_run: { since: "1999-01-04", mean: rv(mean), distance_inverse_pct: f(mean / b.now - 1) },
        above_entry_share: "0.5820",
      },
      rolling: WINDOWS.map((w) => ({
        window: w.window,
        window_days: w.days,
        points: rolling(base, Math.max(1, Math.round(w.days / step)), from),
        typical_move_pct: f(w.typical, 4),
        normal_limit_pct: f(w.limit, 4),
      })),
      stats: [
        { key: "low_since_start", value: "1.0412", unit: "rate", value_display: eurView ? "0.960430" : "1.0412", date: "2022-09-27" },
        { key: "high_since_start", value: "1.2271", unit: "rate", value_display: eurView ? "0.814930" : "1.2271", date: "2021-01-06" },
        { key: "avg_rate_holding", value: "1.1186", unit: "rate", value_display: eurView ? "0.893975" : "1.1186" },
        { key: "share_above_avg", value: "0.4210", unit: "fraction" },
        { key: "rate_volatility", value: "0.0741", unit: "fraction" },
      ],
    };
  };
  return { EUR: pick("EUR"), USD: pick("USD") };
}

/** `GET /api/currency/scenarios/both`. */
export function scenariosFixture(data: Obj): unknown {
  const b = book(data);
  const maxPts = history("max", b).points;
  const lowPt = maxPts.reduce((a, p) => (Number(p.rate) < Number(a.rate) ? p : a));
  const highPt = maxPts.reduce((a, p) => (Number(p.rate) > Number(a.rate) ? p : a));
  const STEP = 0.005;
  const MIN = 0.9;
  const MAX = 1.6;
  const valueAt = (ccy: "EUR" | "USD", r: number) => (ccy === "EUR" ? b.usd / r + b.eur : b.usd + b.eur * r);
  const gainAt = (ccy: "EUR" | "USD", r: number) => (ccy === "EUR" ? b.usd / r - b.usd / b.avg : b.eur * (r - b.avg));
  const pick = (ccy: "EUR" | "USD") => {
    const eurView = ccy === "EUR";
    const disp = (r: number) => (eurView ? f(1 / r, 6) : f(r, 4));
    const rows = [] as Obj[];
    for (let r = MIN; r <= MAX + 1e-9; r += STEP) {
      rows.push({
        rate: f(r, 4),
        rate_display: disp(r),
        value: f(valueAt(ccy, r), 2),
        gain: f(gainAt(ccy, r), 2),
        to_breakeven: f(b.breakeven - r, 4),
        to_breakeven_pct: f(b.breakeven / r - 1),
      });
    }
    const idx = (r: number) => Math.max(0, Math.min(rows.length - 1, Math.round((r - MIN) / STEP)));
    const mark = (key: string, r: number, date?: string) => ({ key, rate: f(r, 4), rate_display: disp(r), date: date ?? null, row_index: idx(r) });
    const vNow = valueAt(ccy, b.now);
    return {
      ccy,
      as_of: new Date().toISOString().slice(0, 10),
      generated_at: new Date().toISOString().slice(0, 19),
      quote: { pair: eurView ? "USD/EUR" : "EUR/USD", field: eurView ? "inverse" : "rate" },
      caption: "Exchange rates wander and tend to revert over years; this page describes, it does not predict.",
      step: f(STEP, 3),
      min_rate: f(MIN, 2),
      max_rate: f(MAX, 2),
      rate_now: rv(b.now),
      value_now: f(vNow, 2),
      avg_rate: rv(b.avg),
      breakeven: rv(b.breakeven),
      rows,
      marks: [
        mark("historic_low", Number(lowPt.rate), lowPt.t),
        mark("average", b.avg),
        mark("breakeven", b.breakeven),
        mark("today", b.now),
        mark("historic_high", Number(highPt.rate), highPt.t),
      ],
      stress: [-0.15, -0.1, -0.05, 0.05, 0.1, 0.15].map((s) => {
        const r = b.now * (1 + s);
        return { shift_pct: f(s, 2), rate: f(r, 4), rate_display: disp(r), value: f(valueAt(ccy, r), 2), change: f(valueAt(ccy, r) - vNow, 2) };
      }),
      sensitivity: {
        rate: f(b.now, 4),
        value_at_rate: f(vNow, 2),
        value_at_rate_plus: f(valueAt(ccy, b.now + 0.01), 2),
        change: f(valueAt(ccy, b.now + 0.01) - vNow, 2),
      },
      cushion: {
        since: "2019-03-04",
        volatility_eur: "0.1424",
        volatility_usd: "0.1681",
        max_drawdown_eur: "-0.2108",
        max_drawdown_usd: "-0.3392",
        down_days: 812,
        down_days_dollar_rose: 497,
        dollar_rose_share: "0.6121",
      },
      stats: [
        { key: "one_cent", value: f(valueAt(ccy, b.now + 0.01) - vNow, 2), unit: "money", currency: ccy },
        { key: "breakeven", value: f(b.breakeven, 4), unit: "rate", value_display: disp(b.breakeven), secondary: f(b.breakeven / b.now - 1), secondary_unit: "fraction" },
        { key: "value_at_low", value: f(valueAt(ccy, Number(lowPt.rate)), 2), unit: "money", currency: ccy, secondary: lowPt.rate, secondary_unit: "rate", secondary_display: disp(Number(lowPt.rate)), date: lowPt.t },
        { key: "value_at_high", value: f(valueAt(ccy, Number(highPt.rate)), 2), unit: "money", currency: ccy, secondary: highPt.rate, secondary_unit: "rate", secondary_display: disp(Number(highPt.rate)), date: highPt.t },
        { key: "volatility", value: "0.1424", unit: "fraction", secondary: "0.1681", secondary_unit: "fraction" },
        { key: "deepest_fall", value: "-0.2108", unit: "fraction", secondary: "-0.3392", secondary_unit: "fraction" },
        { key: "dollar_rose_on_down_days", value: "0.6121", unit: "fraction" },
      ],
    };
  };
  return { EUR: pick("EUR"), USD: pick("USD") };
}

/** Adds `current_by_currency` + `currency_note` to the recorded allocations (until recorded). */
export function withAllocationCurrency(body: unknown, data: Obj): unknown {
  if (!body || typeof body !== "object") return body;
  const out: Obj = { ...(body as Obj) };
  for (const ccy of ["EUR", "USD"]) {
    const side = out[ccy] as Obj | undefined;
    if (!side || "current_by_currency" in side) continue;
    const groups = (get(data, "GET /api/holdings/both?group_by=currency", ccy, "groups") ?? []) as Obj[];
    out[ccy] = {
      ...side,
      current_by_currency: groups.map((g) => ({ label: g.key, value: g.value, pct: g.weight_pct })),
      currency_note:
        "By the currency each holding trades in. A world fund priced in dollars is not purely dollar exposure: it owns companies in many currencies.",
    };
  }
  return out;
}

/** Adds the P5 rate band to a recorded EUR projection (until recorded). */
export function withRateBand(body: unknown, data: Obj): unknown {
  if (!body || typeof body !== "object") return body;
  const p = body as Obj;
  if ("rate_band" in p || p.ccy !== "EUR") return body;
  const b = book(data);
  const now = num(get(p, "assumptions", "usd_per_eur"), b.now);
  const fin = (get(p, "final") ?? {}) as Obj;
  // The dollar wallet's share of the projection, in native dollars at today's rate.
  const usd = (k: string) => (fin[k] == null ? null : Number(fin[k]) * b.usdShare * now);
  const eurPart = (k: string) => (fin[k] == null ? 0 : Number(fin[k]) * (1 - b.usdShare));
  const at = (k: string, r: number) => {
    const u = usd(k);
    return u === null ? null : f(u / r + eurPart(k), 2);
  };
  const rows = [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15].map((s) => {
    const r = now * (1 + s);
    return { usd_per_eur: f(r, 4), shift_pct: f(s, 2), pessimistic: at("pessimistic", r), expected: at("expected", r), optimistic: at("optimistic", r) };
  });
  return {
    ...p,
    rate_band: {
      ccy: "EUR",
      usd_per_eur_now: f(now, 4),
      final_usd: {
        pessimistic: f(usd("pessimistic") ?? 0, 2),
        expected: f(usd("expected") ?? 0, 2),
        optimistic: f(usd("optimistic") ?? 0, 2),
        projected_growth: null,
      },
      rows,
      expected_low: rows[rows.length - 1].expected,
      expected_high: rows[0].expected,
    },
  };
}
