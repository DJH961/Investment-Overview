/**
 * Synthetic `GET /api/currency/rate-history` for fixture mode, until the recorder
 * writes the real endpoint. A seeded, mean-reverting random walk: invented data with
 * a plausible EUR/USD shape, never market or ledger data.
 */

type Pt = { t: string; rate: string; inverse: string };

const DAY = 86_400_000;
const START = Date.UTC(1999, 0, 4);

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

let cache: { day: string; rate: number }[] | null = null;

/** Business days from 1999 to today, rate in USD per EUR. */
function dailySeries(): { day: string; rate: number }[] {
  if (cache) return cache;
  const rnd = mulberry32(20261121);
  const out: { day: string; rate: number }[] = [];
  let log = Math.log(1.17);
  const today = Date.now();
  for (let t = START; t <= today; t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    // Slow drift through a long cycle (the euro's 2000 low and 2008 high), plus noise.
    const years = (t - START) / (365.25 * DAY);
    const anchor = Math.log(1.17 + 0.22 * Math.sin((years - 3.4) * 0.55));
    const shock = (rnd() + rnd() + rnd() - 1.5) * 0.0088;
    log += 0.004 * (anchor - log) + shock;
    out.push({ day: new Date(t).toISOString().slice(0, 10), rate: Math.exp(log) });
  }
  cache = out;
  return out;
}

const pt = (t: string, rate: number): Pt => ({ t, rate: rate.toFixed(5), inverse: (1 / rate).toFixed(6) });

function startFor(range: string, lastDay: string): string {
  const d = new Date(`${lastDay}T00:00:00Z`);
  const back = (days: number) => new Date(d.getTime() - days * DAY).toISOString().slice(0, 10);
  switch (range) {
    case "1m":
      return back(31);
    case "3m":
      return back(92);
    case "ytd":
      return `${lastDay.slice(0, 4)}-01-01`;
    case "1y":
      return back(366);
    case "5y":
      return back(5 * 366);
    case "10y":
      return back(10 * 366);
    case "max":
      return "1999-01-01";
    default:
      return back(366);
  }
}

function intraday(range: string, last: number): Pt[] {
  const rnd = mulberry32(range === "1d" ? 7 : 11);
  const sessions = range === "1d" ? 1 : 5;
  const out: Pt[] = [];
  const now = Date.now();
  let r = last * (1 + (rnd() - 0.5) * 0.006);
  for (let s = sessions - 1; s >= 0; s--) {
    const day = new Date(now - s * DAY);
    const open = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 14, 30);
    for (let m = 0; m <= 390; m += range === "1d" ? 5 : 30) {
      const t = open + m * 60_000;
      if (t > now) break;
      r *= 1 + (rnd() - 0.5) * 0.0009;
      out.push(pt(new Date(t).toISOString().slice(0, 19), r));
    }
  }
  return out;
}

/** The fixture portfolio starts here (an invented first deposit, not ledger data). */
export const PORTFOLIO_START = "2019-03-04";
const FIRST_DEPOSIT_EUR = 420_000;
const MONTHLY_DEPOSIT_EUR = 6_000;

/**
 * The fixture's euro deposits: one lump on the first day, then a regular amount on the
 * first business day of each month, each converted at that day's rate. The effect fixture
 * books them as flows and the rate chart draws them as conversion markers.
 */
export function depositSchedule(rates: { day: string; rate: number }[]): { day: string; rate: number; eur: number }[] {
  const out: { day: string; rate: number; eur: number }[] = [];
  let month = "";
  for (const p of rates) {
    if (p.day < PORTFOLIO_START) continue;
    const m = p.day.slice(0, 7);
    if (m === month) continue;
    month = m;
    out.push({ day: p.day, rate: p.rate, eur: out.length === 0 ? FIRST_DEPOSIT_EUR : MONTHLY_DEPOSIT_EUR });
  }
  return out;
}

/** The same walk, scaled to end at `now` (the effect fixture builds on it, so Impact and the rate chart agree). */
export function scaledDailyRates(now: number): { day: string; rate: number }[] {
  const raw = dailySeries();
  const k = now / raw[raw.length - 1].rate;
  return raw.map((p) => ({ day: p.day, rate: p.rate * k }));
}

/** The 1D / 1W intraday rate points (same seeds as the chart). */
export function intradayRates(range: "1d" | "1w", now: number): { t: string; rate: number }[] {
  return intraday(range, now).map((p) => ({ t: p.t, rate: Number(p.rate) }));
}

export function rateHistoryFixture(range: string, anchor: { now: number; avg: number; scale?: number }): unknown {
  // Scale the walk so it ends at the fixture's spot (the strip and the chart agree).
  const all = scaledDailyRates(anchor.now);
  const last = all[all.length - 1];
  const avgRate = anchor.avg;
  const granularity = range === "1d" || range === "1w" ? "intraday" : range === "10y" || range === "max" ? "weekly" : "daily";
  const from = startFor(range, last.day);
  const inRange = all.filter((p) => p.day >= from);
  const weekly = (rows: typeof all) => rows.filter((p, i) => i === rows.length - 1 || new Date(`${p.day}T00:00:00Z`).getUTCDay() === 5);
  const daily = granularity === "weekly" ? weekly(inRange) : inRange;
  const points = granularity === "intraday" ? intraday(range, last.rate) : daily.map((p) => pt(p.day, p.rate));
  // 200-day average over the full history, so the line starts at the range start.
  let ma200: Pt[] = [];
  if (granularity !== "intraday" && !["1m", "3m", "ytd"].includes(range)) {
    const idx = new Map(all.map((p, i) => [p.day, i]));
    ma200 = daily.flatMap((p) => {
      const i = idx.get(p.day) ?? 0;
      if (i < 199) return [];
      let s = 0;
      for (let k = i - 199; k <= i; k++) s += all[k].rate;
      return [pt(p.day, s / 200)];
    });
  }
  const nums = points.map((p) => Number(p.rate));
  const lo = nums.indexOf(Math.min(...nums));
  const hi = nums.indexOf(Math.max(...nums));
  const first = nums[0];
  const end = nums[nums.length - 1];
  return {
    range,
    granularity,
    as_of: new Date().toISOString().slice(0, 19),
    source: granularity === "intraday" ? "live samples" : "ECB reference rate",
    points,
    ma200,
    avg_rate: { rate: avgRate.toFixed(4), inverse: (1 / avgRate).toFixed(6) },
    low: points[lo],
    high: points[hi],
    change: {
      start_rate: first.toFixed(5),
      end_rate: end.toFixed(5),
      rate_pct: (end / first - 1).toFixed(6),
      inverse_pct: (first / end - 1).toFixed(6),
    },
    trend: {
      direction: "dollar_down",
      since: all[all.length - 168].day,
      since_change_pct: "-0.0420",
      vs_ma200: "below",
      normal: "normal",
      move_pct: "-0.0110",
      typical_move_pct: "0.0180",
      move_percentile: "0.41",
      window_days: 21,
    },
    percentiles: { since_start: "0.29", y5: "0.34", y10: "0.47", since_1999: "0.38" },
    // The fixture's euro deposits, each converted on its own day (kind: null until 7.3).
    markers: depositSchedule(all)
      .filter((d) => d.day >= from)
      .map((d, i) => ({
        date: d.day,
        rate: d.rate.toFixed(4),
        amount_from: (d.eur * (anchor.scale ?? 1)).toFixed(2),
        from_ccy: "EUR",
        to_ccy: "USD",
        kind: null,
        conversion_id: 1000 + i,
      })),
  };
}
