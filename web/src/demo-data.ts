/**
 * Demo data generator — one simulated ledger behind every number in the demo.
 *
 * From a small persona spec (instruments, target weights, monthly contribution)
 * this builds ~3 years of seeded daily price + EUR/USD paths and replays a
 * ledger over them (monthly deposits that are bought into the target weights,
 * quarterly dividends, money-market interest, an occasional sell). *Everything*
 * the dashboard shows is derived from that one simulation: holdings (shares,
 * cost basis, cashflows), cash, period openings, monthly/yearly rows, deposits,
 * the transaction list, the equity curve + benchmark, the risk/return scalars
 * and the per-holding attribution. Nothing is hand-typed, so the figures agree
 * with each other by construction (total value = holdings + cash, chart tip =
 * headline, attribution sums to total gain, period flows sum to the totals).
 *
 * The history is a pure function of `(persona, demo day)`: a seeded PRNG keyed
 * on the persona id + the NYSE trading day, so it is reproducible per day and
 * dated "today" whenever the demo is opened. Today's session is a seeded
 * minute-by-minute path evaluated at the (faked) current time, so the quotes,
 * the 1D curve and the headline move all describe one live trading day.
 *
 * Money maths in the simulation uses plain numbers rounded to cents at every
 * ledger event; the live book (quotes → value → gain → attribution) is valued
 * with `Decimal` and the app's own `convert`, exactly like the real pipeline.
 */
import { Decimal } from "./decimal-config";
import { convert, type FxRates, type Quote } from "./prices";
import { xirr, type Cashflow } from "./returns";
import {
  isUsTradingDay,
  lastSessionDate,
  previousTradingSession,
  recentTradingSessions,
  sessionCloseMs,
  sessionOpenMs,
} from "./market-hours";
import type { CurvePoint } from "./timeseries";
import type {
  ExportAttributionRow,
  ExportCash,
  ExportCashflow,
  ExportDepositRecord,
  ExportHolding,
  ExportPeriodRow,
  ExportTransactionRecord,
  MobileExport,
} from "./types";

// ---------------------------------------------------------------------------
// Persona specs
// ---------------------------------------------------------------------------

export interface InstrumentSpec {
  symbol: string;
  name: string;
  assetClass: string;
  category: string;
  currency: "USD" | "EUR";
  /** `nav` = a once-a-day fund price (mutual fund / money-market sweep). */
  priceType: "market" | "nav";
  moneyMarket?: boolean;
  account: string;
  broker: string;
  startPrice: number;
  /** Price return over the whole window (bridged to, so the end level is sane). */
  targetReturn: number;
  /** Annualised volatility. */
  vol: number;
  /** Sensitivity to the market factor (the benchmark's move). */
  beta: number;
  /** Annual distribution yield (0 = accumulating / none). */
  yield: number;
  /** Reinvest distributions into the same instrument instead of paying cash. */
  drip: boolean;
  /** Share of each monthly deposit that buys this instrument. */
  weight: number;
  /** Extra move today, so each persona has a clear winner and loser. */
  dayBias?: number;
}

export interface PersonaSpec {
  id: string;
  label: string;
  tagline: string;
  /** Monthly deposit (EUR). */
  monthlyEur: number;
  /** First deposit as a multiple of the monthly amount. */
  leadMultiple: number;
  /** Total log-change of EUR/USD over the window (euro up = positive). */
  fxChange: number;
  fxStart: number;
  /** Extra EUR/USD move today (log). */
  fxDayBias: number;
  instruments: InstrumentSpec[];
  /** One occasional sell: `at` is a 0..1 position in the window. */
  sell: { symbol: string; at: number; fraction: number };
}

const BROKER = "Sample Broker";

function inst(spec: Omit<InstrumentSpec, "broker">): InstrumentSpec {
  return { broker: BROKER, ...spec };
}

export const DEMO_SPECS: readonly PersonaSpec[] = [
  {
    id: "global",
    label: "Global ETF saver",
    tagline: "A diversified buy-and-hold book — world ETF, a bond fund, a mutual fund, a money-market sweep and two blue chips.",
    monthlyEur: 1000,
    leadMultiple: 8,
    fxChange: 0.02,
    fxStart: 1.07,
    fxDayBias: 0.0012,
    sell: { symbol: "AAPL", at: 0.62, fraction: 0.2 },
    instruments: [
      inst({ symbol: "VWCE", name: "Vanguard FTSE All-World UCITS ETF", assetClass: "etf", category: "Global equity", currency: "EUR", priceType: "market", account: "Taxable", startPrice: 96, targetReturn: 0.36, vol: 0.14, beta: 0.95, yield: 0, drip: false, weight: 0.32 }),
      inst({ symbol: "AAPL", name: "Apple Inc.", assetClass: "equity", category: "US stocks", currency: "USD", priceType: "market", account: "Taxable", startPrice: 152, targetReturn: 0.38, vol: 0.26, beta: 1.15, yield: 0.005, drip: false, weight: 0.12, dayBias: -0.006 }),
      inst({ symbol: "MSFT", name: "Microsoft Corporation", assetClass: "equity", category: "US stocks", currency: "USD", priceType: "market", account: "Pension", startPrice: 285, targetReturn: 0.52, vol: 0.24, beta: 1.1, yield: 0.007, drip: true, weight: 0.12, dayBias: 0.012 }),
      inst({ symbol: "AGGH", name: "iShares Core Global Aggregate Bond UCITS ETF", assetClass: "bond", category: "Bonds", currency: "EUR", priceType: "market", account: "Taxable", startPrice: 4.82, targetReturn: 0.03, vol: 0.06, beta: 0.12, yield: 0.025, drip: true, weight: 0.17 }),
      inst({ symbol: "FCNTX", name: "Fidelity Contrafund", assetClass: "mutual_fund", category: "Funds", currency: "USD", priceType: "nav", account: "Pension", startPrice: 15.2, targetReturn: 0.46, vol: 0.19, beta: 1.05, yield: 0.01, drip: true, weight: 0.15 }),
      inst({ symbol: "VMFXX", name: "Vanguard Federal Money Market Fund", assetClass: "money_market", category: "Cash & sweep", currency: "USD", priceType: "nav", moneyMarket: true, account: "Taxable", startPrice: 1, targetReturn: 0, vol: 0, beta: 0, yield: 0.043, drip: true, weight: 0.12 }),
    ],
  },
  {
    id: "tech",
    label: "US tech-heavy",
    tagline: "A concentrated growth book (incl. a deliberate loser) — bigger swings, fatter drawdowns, higher beta.",
    monthlyEur: 900,
    leadMultiple: 12,
    fxChange: 0.04,
    fxStart: 1.05,
    fxDayBias: -0.0008,
    sell: { symbol: "TSLA", at: 0.7, fraction: 0.25 },
    instruments: [
      inst({ symbol: "NVDA", name: "NVIDIA Corporation", assetClass: "equity", category: "Semiconductors", currency: "USD", priceType: "market", account: "Taxable", startPrice: 62, targetReturn: 1.9, vol: 0.5, beta: 1.7, yield: 0.001, drip: false, weight: 0.2, dayBias: 0.013 }),
      inst({ symbol: "AAPL", name: "Apple Inc.", assetClass: "equity", category: "Big tech", currency: "USD", priceType: "market", account: "Taxable", startPrice: 150, targetReturn: 0.36, vol: 0.26, beta: 1.1, yield: 0.005, drip: false, weight: 0.17 }),
      inst({ symbol: "MSFT", name: "Microsoft Corporation", assetClass: "equity", category: "Big tech", currency: "USD", priceType: "market", account: "Pension", startPrice: 280, targetReturn: 0.52, vol: 0.24, beta: 1.1, yield: 0.007, drip: true, weight: 0.17 }),
      inst({ symbol: "GOOGL", name: "Alphabet Inc. Class A", assetClass: "equity", category: "Big tech", currency: "USD", priceType: "market", account: "Taxable", startPrice: 100, targetReturn: 0.62, vol: 0.3, beta: 1.2, yield: 0, drip: false, weight: 0.15 }),
      inst({ symbol: "TSLA", name: "Tesla, Inc.", assetClass: "equity", category: "Autos", currency: "USD", priceType: "market", account: "Taxable", startPrice: 270, targetReturn: -0.16, vol: 0.55, beta: 1.6, yield: 0, drip: false, weight: 0.13, dayBias: -0.011 }),
      inst({ symbol: "QQQ", name: "Invesco QQQ Trust", assetClass: "etf", category: "Index ETFs", currency: "USD", priceType: "market", account: "Pension", startPrice: 330, targetReturn: 0.58, vol: 0.22, beta: 1.15, yield: 0.006, drip: true, weight: 0.18 }),
    ],
  },
  {
    id: "fx",
    label: "FX-diverging euro investor",
    tagline: "A euro saver almost entirely in USD assets — flip the currency toggle to watch EUR and USD diverge.",
    monthlyEur: 1500,
    leadMultiple: 12,
    fxChange: 0.1,
    fxStart: 1.03,
    fxDayBias: 0.0016,
    sell: { symbol: "SCHD", at: 0.55, fraction: 0.15 },
    instruments: [
      inst({ symbol: "VOO", name: "Vanguard S&P 500 ETF", assetClass: "etf", category: "US equity", currency: "USD", priceType: "market", account: "Taxable", startPrice: 365, targetReturn: 0.48, vol: 0.16, beta: 1, yield: 0.013, drip: false, weight: 0.3, dayBias: 0.007 }),
      inst({ symbol: "SCHD", name: "Schwab US Dividend Equity ETF", assetClass: "etf", category: "US equity", currency: "USD", priceType: "market", account: "Taxable", startPrice: 70, targetReturn: 0.22, vol: 0.15, beta: 0.85, yield: 0.035, drip: false, weight: 0.15 }),
      inst({ symbol: "BRK.B", name: "Berkshire Hathaway Inc. Class B", assetClass: "equity", category: "US equity", currency: "USD", priceType: "market", account: "Pension", startPrice: 310, targetReturn: 0.5, vol: 0.17, beta: 0.8, yield: 0, drip: false, weight: 0.15 }),
      inst({ symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", assetClass: "bond", category: "Bonds", currency: "USD", priceType: "market", account: "Taxable", startPrice: 108, targetReturn: -0.1, vol: 0.15, beta: -0.2, yield: 0.035, drip: true, weight: 0.12, dayBias: -0.005 }),
      inst({ symbol: "IWDA", name: "iShares Core MSCI World UCITS ETF (EUR)", assetClass: "etf", category: "Global equity", currency: "EUR", priceType: "market", account: "Taxable", startPrice: 74, targetReturn: 0.42, vol: 0.15, beta: 0.95, yield: 0, drip: false, weight: 0.2 }),
      inst({ symbol: "SWVXX", name: "Schwab Value Advantage Money Fund", assetClass: "money_market", category: "Cash & sweep", currency: "USD", priceType: "nav", moneyMarket: true, account: "Taxable", startPrice: 1, targetReturn: 0, vol: 0, beta: 0, yield: 0.042, drip: true, weight: 0.08 }),
    ],
  },
];

/** The benchmark every persona is measured against. */
export const DEMO_BENCHMARK = { symbol: "VT", startPrice: 92, targetReturn: 0.4, vol: 0.15 } as const;

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash — stable spreading of a string into a PRNG seed. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 PRNG with a Box–Muller normal. */
class Rng {
  private state: number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const fmt2 = (n: number): string => r2(n).toFixed(2);

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function isTradingIso(iso: string): boolean {
  return isUsTradingDay(new Date(`${iso}T12:00:00Z`));
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Trading days in `[fromIso, toIso]`, ascending (cached across personas). */
const tradingDayCache = new Map<string, string[]>();
function tradingDays(fromIso: string, toIso: string): string[] {
  const key = `${fromIso}|${toIso}`;
  const hit = tradingDayCache.get(key);
  if (hit) return hit;
  const out: string[] = [];
  for (let iso = fromIso; iso <= toIso; iso = addDaysIso(iso, 1)) {
    const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6 && isTradingIso(iso)) out.push(iso);
  }
  tradingDayCache.set(key, out);
  if (tradingDayCache.size > 6) tradingDayCache.delete(tradingDayCache.keys().next().value as string);
  return out;
}

function monthsBack(iso: string, months: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 - months;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

/** All `YYYY-MM` labels from `fromMonth` to `toMonth` inclusive. */
function monthLabels(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let y = Number(fromMonth.slice(0, 4));
  let m = Number(fromMonth.slice(5, 7));
  const ey = Number(toMonth.slice(0, 4));
  const em = Number(toMonth.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// History simulation
// ---------------------------------------------------------------------------

const SESSION_MINUTES = 390;
const WINDOW_MONTHS = 36;
const RISK_FREE = 0.03;

interface TxnDraft {
  date: string;
  account: string;
  kind: string;
  symbol: string;
  quantity: number | null;
  price: number | null;
  fees: number | null;
  gross: number | null;
  net: number;
  netEur: number;
  netUsd: number;
  source: string;
}

interface FlowDraft {
  date: string;
  eur: number;
  usd: number;
}

interface IncomeBucket {
  div: number;
  int: number;
  divUsd: number;
  intUsd: number;
}

interface Holder {
  shares: number;
  costNative: number;
  costEur: number;
  costUsd: number;
  incomeEur: number;
  realizedEur: number;
  flows: FlowDraft[];
}

/** The deterministic part of a demo: everything up to the previous close. */
export interface DemoHistory {
  spec: PersonaSpec;
  /** The demo's trading day ("today") and the session before it. */
  day: string;
  prevDay: string;
  dates: string[];
  fx: number[];
  /** `prices[i][d]` native close of instrument `i` (benchmark is `bench`). */
  prices: number[][];
  bench: number[];
  /** Positions at each day's close: `shares[d][i]`. */
  shares: number[][];
  cashEur: number[];
  cashUsd: number[];
  valueEur: number[];
  valueUsd: number[];
  flowEur: number[];
  flowUsd: number[];
  cumEur: number[];
  cumUsd: number[];
  txns: TxnDraft[];
  holders: Holder[];
  deposits: Array<{ date: string; eur: number; usd: number; description: string }>;
  income: Map<string, IncomeBucket>;
  /** Cash dividends/proceeds received into cash, EUR at receipt (USD cash only). */
  usdCashReceivedEur: number;
  dayPaths: DayPaths;
}

interface DayPaths {
  /** `price[i][m]` for instrument `i` at session minute `m` (0..390). */
  price: Float64Array[];
  bench: Float64Array;
  fx: Float64Array;
}

function gbmPath(rng: Rng, n: number, startPrice: number, targetReturn: number, vol: number, beta: number, market: number[], marketVol: number, jitter: number): number[] {
  const idio = Math.sqrt(Math.max(vol * vol - beta * beta * marketVol * marketVol, 0.05 * 0.05 * (vol > 0 ? 1 : 0))) / Math.sqrt(252);
  const r: number[] = [];
  for (let d = 0; d < n; d += 1) r.push(vol === 0 ? 0 : beta * market[d] + idio * rng.normal());
  // Bridge the total log-return to the (jittered) target so the end level is sane.
  const target = Math.log(1 + targetReturn) + (vol === 0 ? 0 : jitter);
  const sum = r.reduce((a, b) => a + b, 0);
  const shift = (target - sum) / n;
  const prices: number[] = [];
  let level = startPrice;
  for (let d = 0; d < n; d += 1) {
    level *= Math.exp(r[d] + shift);
    prices.push(vol === 0 ? startPrice : level >= 20 ? r2(level) : r4(level));
  }
  return prices;
}

function buildDayPaths(spec: PersonaSpec, rng: Rng, prevPrices: number[], prevBench: number, prevFx: number): DayPaths {
  const marketDay = 0.004 + 0.009 * rng.next();
  const walk = (): Float64Array => {
    // A standard Brownian bridge over the session: zero at both ends.
    const w = new Float64Array(SESSION_MINUTES + 1);
    for (let m = 1; m <= SESSION_MINUTES; m += 1) w[m] = w[m - 1] + rng.normal() / Math.sqrt(SESSION_MINUTES);
    const end = w[SESSION_MINUTES];
    for (let m = 0; m <= SESSION_MINUTES; m += 1) w[m] -= (m / SESSION_MINUTES) * end;
    return w;
  };
  const market = walk();
  const build = (prev: number, beta: number, vol: number, bias: number, decimals: number): Float64Array => {
    const out = new Float64Array(SESSION_MINUTES + 1);
    const dailySd = vol / Math.sqrt(252);
    const closeMove = beta * marketDay + rng.normal() * dailySd * 0.35 + bias;
    const gap = closeMove * 0.3 + rng.normal() * dailySd * 0.12;
    const own = walk();
    const k = 10 ** decimals;
    for (let m = 0; m <= SESSION_MINUTES; m += 1) {
      const trend = gap + (closeMove - gap) * (m / SESSION_MINUTES);
      const noise = dailySd * 0.9 * (0.5 * Math.sign(beta || 1) * market[m] + 0.866 * own[m]);
      out[m] = Math.round(prev * Math.exp(trend + noise) * k) / k;
    }
    return out;
  };
  const price = spec.instruments.map((s, i) =>
    s.moneyMarket || s.priceType === "nav"
      ? new Float64Array(SESSION_MINUTES + 1).fill(prevPrices[i])
      : build(prevPrices[i], s.beta, s.vol, s.dayBias ?? 0, prevPrices[i] >= 20 ? 2 : 4),
  );
  const bench = build(prevBench, 1, DEMO_BENCHMARK.vol, 0, 2);
  // EUR/USD: a small seeded day move with its own bridge, rounded to 5 dp.
  const fx = new Float64Array(SESSION_MINUTES + 1);
  const fxSd = 0.055 / Math.sqrt(252);
  const fxClose = rng.normal() * fxSd * 0.6 + spec.fxDayBias;
  const fxGap = fxClose * 0.2;
  const fxWalk = walk();
  for (let m = 0; m <= SESSION_MINUTES; m += 1) {
    const trend = fxGap + (fxClose - fxGap) * (m / SESSION_MINUTES);
    fx[m] = Math.round(prevFx * Math.exp(trend + fxSd * 0.7 * fxWalk[m]) * 1e5) / 1e5;
  }
  return { price, bench, fx };
}

const historyCache = new Map<string, DemoHistory>();

/** The simulated history for `(persona, demo day)`, cached. */
export function buildHistory(spec: PersonaSpec, day: string): DemoHistory {
  const key = `${spec.id}|${day}`;
  const hit = historyCache.get(key);
  if (hit) return hit;
  const built = simulate(spec, day);
  historyCache.set(key, built);
  if (historyCache.size > 6) historyCache.delete(historyCache.keys().next().value as string);
  return built;
}

function simulate(spec: PersonaSpec, day: string): DemoHistory {
  const prevDay = previousTradingSession(day);
  const first = monthsBack(day, WINDOW_MONTHS);
  const dates = tradingDays(first, prevDay);
  const n = dates.length;
  const seed = hashString(`${spec.id}|${day}`);
  const rng = new Rng(seed);
  const insts = spec.instruments;

  // --- Price + FX paths --------------------------------------------------
  const marketVol = 0.15;
  const market: number[] = [];
  for (let d = 0; d < n; d += 1) market.push((marketVol / Math.sqrt(252)) * rng.normal());
  // Tilt the recent market so the demo opens on a healthy year and month (the
  // instruments inherit it through their betas): drift the year-to-date and
  // month-to-date segments toward a mild positive pace, keeping the noise.
  const segmentShift = (from: number, to: number, annualPace: number): void => {
    if (to - from < 1) return;
    const sum = market.slice(from, to).reduce((a, b) => a + b, 0);
    const shift = (annualPace * ((to - from) / 252) - sum) / (to - from);
    for (let i = from; i < to; i += 1) market[i] += shift;
  };
  const firstIdx = (iso: string): number => {
    const i = dates.findIndex((x) => x >= iso);
    return i < 0 ? n : i;
  };
  const yStart = firstIdx(`${day.slice(0, 4)}-01-01`);
  const mStart = firstIdx(`${day.slice(0, 7)}-01`);
  segmentShift(yStart, mStart, 0.07 + 0.1 * rng.next());
  segmentShift(mStart, n, 0.05 + 0.3 * rng.next());
  const prices = insts.map((s) =>
    gbmPath(new Rng(hashString(`${seed}|${s.symbol}`)), n, s.startPrice, s.targetReturn, s.vol, s.beta, market, marketVol, (rng.next() - 0.5) * 0.08),
  );
  const bench = gbmPath(new Rng(hashString(`${seed}|VT`)), n, DEMO_BENCHMARK.startPrice, DEMO_BENCHMARK.targetReturn, DEMO_BENCHMARK.vol, 1, market, marketVol, (rng.next() - 0.5) * 0.06);
  const fxRng = new Rng(hashString(`${seed}|fx`));
  const fxRaw: number[] = [];
  for (let d = 0; d < n; d += 1) fxRaw.push(0.055 / Math.sqrt(252) * fxRng.normal());
  const fxShift = (spec.fxChange - fxRaw.reduce((a, b) => a + b, 0)) / n;
  const fx: number[] = [];
  let fxLevel = spec.fxStart;
  for (let d = 0; d < n; d += 1) {
    fxLevel *= Math.exp(fxRaw[d] + fxShift);
    fx.push(Math.round(fxLevel * 1e5) / 1e5);
  }

  // --- Ledger replay -----------------------------------------------------
  const holders: Holder[] = insts.map(() => ({ shares: 0, costNative: 0, costEur: 0, costUsd: 0, incomeEur: 0, realizedEur: 0, flows: [] }));
  const txns: TxnDraft[] = [];
  const deposits: DemoHistory["deposits"] = [];
  const income = new Map<string, IncomeBucket>();
  const bucket = (month: string): IncomeBucket => {
    let b = income.get(month);
    if (!b) {
      b = { div: 0, int: 0, divUsd: 0, intUsd: 0 };
      income.set(month, b);
    }
    return b;
  };
  let cashEur = 0;
  let cashUsd = 0;
  let usdCashReceivedEur = 0;
  let cumEur = 0;
  let cumUsd = 0;
  const sharesBy: number[][] = [];
  const cashEurBy: number[] = [];
  const cashUsdBy: number[] = [];
  const valueEur: number[] = [];
  const valueUsd: number[] = [];
  const flowEur: number[] = [];
  const flowUsd: number[] = [];
  const cumEurBy: number[] = [];
  const cumUsdBy: number[] = [];
  const totalWeight = insts.reduce((a, s) => a + s.weight, 0);
  const sellDay = Math.floor(n * spec.sell.at);
  const toEur = (native: number, s: InstrumentSpec, rate: number): number => (s.currency === "USD" ? native / rate : native);
  const toUsd = (native: number, s: InstrumentSpec, rate: number): number => (s.currency === "USD" ? native : native * rate);

  for (let d = 0; d < n; d += 1) {
    const date = dates[d];
    const rate = fx[d];
    const month = date.slice(0, 7);
    const firstOfMonth = d === 0 || dates[d - 1].slice(0, 7) !== month;
    const lastOfMonth = d < n - 1 && dates[d + 1].slice(0, 7) !== month;
    let dayDepositEur = 0;
    let dayDepositUsd = 0;

    // Occasional sell.
    if (d === sellDay) {
      const j = insts.findIndex((s) => s.symbol === spec.sell.symbol);
      const s = insts[j];
      const h = holders[j];
      if (j >= 0 && h.shares > 0) {
        const qty = r2(h.shares * spec.sell.fraction);
        const p = prices[j][d];
        const fee = 1;
        const gross = r2(qty * p);
        const net = r2(gross - fee);
        const frac = qty / h.shares;
        const removedEur = h.costEur * frac;
        const proceedsEur = r2(toEur(net, s, rate));
        const proceedsUsd = r2(toUsd(net, s, rate));
        h.shares = r4(h.shares - qty);
        h.costNative -= h.costNative * frac;
        h.costEur -= removedEur;
        h.costUsd -= h.costUsd * frac;
        h.realizedEur += proceedsEur - removedEur;
        h.flows.push({ date, eur: proceedsEur, usd: proceedsUsd });
        if (s.currency === "USD") {
          cashUsd = r2(cashUsd + net);
          usdCashReceivedEur += proceedsEur;
        } else {
          cashEur = r2(cashEur + net);
        }
        txns.push({ date, account: s.account, kind: "sell", symbol: s.symbol, quantity: -qty, price: p, fees: fee, gross, net, netEur: proceedsEur, netUsd: proceedsUsd, source: "manual" });
      }
    }

    // Distributions.
    const dom = Number(date.slice(8));
    const prevDom = d > 0 && dates[d - 1].slice(0, 7) === month ? Number(dates[d - 1].slice(8)) : 0;
    const crossesMid = dom >= 15 && prevDom < 15;
    insts.forEach((s, j) => {
      const h = holders[j];
      if (h.shares <= 0 || s.yield <= 0) return;
      const p = prices[j][d];
      if (s.moneyMarket) {
        if (!lastOfMonth) return;
        const amount = r2(h.shares * (s.yield / 12));
        if (amount <= 0) return;
        const eur = r2(toEur(amount, s, rate));
        const usd = r2(toUsd(amount, s, rate));
        h.shares = r4(h.shares + amount);
        h.costNative += amount;
        h.costEur += eur;
        h.costUsd += usd;
        h.incomeEur += eur;
        const b = bucket(month);
        b.int += eur;
        b.intUsd += usd;
        txns.push({ date, account: s.account, kind: "interest", symbol: s.symbol, quantity: null, price: null, fees: null, gross: amount, net: amount, netEur: eur, netUsd: usd, source: "import" });
        return;
      }
      if (!crossesMid || (Number(month.slice(5)) + j) % 3 !== 0) return;
      const amount = r2(h.shares * p * (s.yield / 4));
      if (amount <= 0) return;
      const eur = r2(toEur(amount, s, rate));
      const usd = r2(toUsd(amount, s, rate));
      const b = bucket(month);
      b.div += eur;
      b.divUsd += usd;
      h.incomeEur += eur;
      if (s.drip) {
        const qty = r4(amount / p);
        h.shares = r4(h.shares + qty);
        h.costNative += amount;
        h.costEur += eur;
        h.costUsd += usd;
        txns.push({ date, account: s.account, kind: "dividend_reinvest", symbol: s.symbol, quantity: qty, price: p, fees: null, gross: amount, net: -amount, netEur: -eur, netUsd: -usd, source: "import" });
      } else {
        h.flows.push({ date, eur, usd });
        if (s.currency === "USD") {
          cashUsd = r2(cashUsd + amount);
          usdCashReceivedEur += eur;
        } else {
          cashEur = r2(cashEur + amount);
        }
        txns.push({ date, account: s.account, kind: "dividend", symbol: s.symbol, quantity: null, price: null, fees: null, gross: amount, net: amount, netEur: eur, netUsd: usd, source: "import" });
      }
    });

    // Monthly deposit, bought into the target weights at today's close.
    if (firstOfMonth) {
      const amount = spec.monthlyEur * (d === 0 ? spec.leadMultiple : 1);
      const usd = r2(amount * rate);
      cashEur = r2(cashEur + amount);
      cumEur = r2(cumEur + amount);
      cumUsd = r2(cumUsd + usd);
      dayDepositEur = amount;
      dayDepositUsd = usd;
      const description = d === 0 ? "Initial deposit" : "Monthly savings";
      deposits.push({ date, eur: amount, usd, description });
      txns.push({ date, account: "Taxable", kind: "deposit", symbol: "", quantity: null, price: null, fees: null, gross: amount, net: amount, netEur: amount, netUsd: usd, source: "manual" });
      insts.forEach((s, j) => {
        const budgetEur = (amount * s.weight) / totalWeight;
        const budgetNative = s.currency === "USD" ? budgetEur * rate : budgetEur;
        const p = prices[j][d];
        const fee = s.moneyMarket ? 0 : 1;
        const qty = s.moneyMarket ? Math.floor(budgetNative * 100) / 100 : Math.floor(((budgetNative - fee) / p) * 100) / 100;
        if (qty <= 0) return;
        const gross = r2(qty * p);
        const nativeCost = r2(gross + fee);
        const costEur = r2(toEur(nativeCost, s, rate));
        const costUsd = r2(toUsd(nativeCost, s, rate));
        const h = holders[j];
        h.shares = r4(h.shares + qty);
        h.costNative += nativeCost;
        h.costEur += costEur;
        h.costUsd += costUsd;
        h.flows.push({ date, eur: -costEur, usd: -costUsd });
        cashEur = r2(Math.max(0, cashEur - costEur));
        txns.push({ date, account: s.account, kind: "buy", symbol: s.symbol, quantity: qty, price: p, fees: fee, gross, net: -nativeCost, netEur: -costEur, netUsd: -costUsd, source: "import" });
      });
    }

    // End-of-day snapshot.
    sharesBy.push(holders.map((h) => h.shares));
    cashEurBy.push(cashEur);
    cashUsdBy.push(cashUsd);
    let ve = cashEur + cashUsd / rate;
    let vu = cashUsd + cashEur * rate;
    insts.forEach((s, j) => {
      const native = holders[j].shares * prices[j][d];
      ve += toEur(native, s, rate);
      vu += toUsd(native, s, rate);
    });
    valueEur.push(ve);
    valueUsd.push(vu);
    flowEur.push(dayDepositEur);
    flowUsd.push(dayDepositUsd);
    cumEurBy.push(cumEur);
    cumUsdBy.push(cumUsd);
  }

  const dayPaths = buildDayPaths(
    spec,
    new Rng(hashString(`${seed}|today`)),
    prices.map((p) => p[n - 1]),
    bench[n - 1],
    fx[n - 1],
  );
  return {
    spec, day, prevDay, dates, fx, prices, bench,
    shares: sharesBy, cashEur: cashEurBy, cashUsd: cashUsdBy,
    valueEur, valueUsd, flowEur, flowUsd, cumEur: cumEurBy, cumUsd: cumUsdBy,
    txns, holders, deposits, income, usdCashReceivedEur, dayPaths,
  };
}

// ---------------------------------------------------------------------------
// Risk statistics (numbers; the scalars are display-only "as of export")
// ---------------------------------------------------------------------------

const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function stdev(xs: number[]): number {
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
}

interface RiskScalars {
  twr: number;
  cagr: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  calmar: number;
  ulcer: number;
  var95: number;
  cvar95: number;
  skew: number;
  kurtosis: number;
  beta: number;
  alpha: number;
}

function riskScalars(r: number[], rb: number[], spanDays: number): RiskScalars {
  const ann = 252;
  const mean = avg(r);
  const sd = stdev(r) || 1e-9;
  const twr = r.reduce((a, x) => a * (1 + x), 1) - 1;
  const years = Math.max(spanDays / 365.25, 1 / 365.25);
  const cagr = (1 + twr) ** (1 / years) - 1;
  const vol = sd * Math.sqrt(ann);
  const excess = mean * ann - RISK_FREE;
  const downside = Math.sqrt(avg(r.map((x) => Math.min(0, x) ** 2))) * Math.sqrt(ann) || 1e-9;
  let index = 1;
  let peak = 1;
  let mdd = 0;
  let ulcerSum = 0;
  for (const x of r) {
    index *= 1 + x;
    peak = Math.max(peak, index);
    const dd = index / peak - 1;
    mdd = Math.min(mdd, dd);
    ulcerSum += (dd * 100) ** 2;
  }
  const sorted = [...r].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(sorted.length * 0.05));
  const var95 = sorted[cut - 1];
  const cvar95 = avg(sorted.slice(0, cut));
  const m3 = avg(r.map((x) => ((x - mean) / sd) ** 3));
  const m4 = avg(r.map((x) => ((x - mean) / sd) ** 4)) - 3;
  const meanB = avg(rb);
  const varB = avg(rb.map((x) => (x - meanB) ** 2)) || 1e-9;
  const cov = avg(r.map((x, i) => (x - mean) * (rb[i] - meanB)));
  const beta = cov / varB;
  const alpha = (mean - RISK_FREE / ann - beta * (meanB - RISK_FREE / ann)) * ann;
  return {
    twr, cagr, volatility: vol, sharpe: excess / vol, sortino: excess / downside,
    maxDrawdown: mdd, calmar: Math.abs(mdd) > 1e-9 ? cagr / Math.abs(mdd) : 0,
    ulcer: Math.sqrt(ulcerSum / r.length), var95, cvar95, skew: m3, kurtosis: m4, beta, alpha,
  };
}

// ---------------------------------------------------------------------------
// The scene: history + a live moment
// ---------------------------------------------------------------------------

export interface DemoScene {
  history: DemoHistory;
  nowMs: number;
  /** Minutes since the 09:30 ET open, 0..390 (fractional). */
  minute: number;
  data: MobileExport;
  quotes: Map<string, Quote>;
  fx: FxRates;
  fxPrevEurUsd: Decimal;
  fxSessionOpen: Decimal;
  /** The coverage line a healthy live session shows ("6/6 live, …"). */
  coverage: string;
  /** The live whole-book total in both currencies (Decimal, from the quotes). */
  totalEur: Decimal;
  totalUsd: Decimal;
  /** Build the 1D / 1W curves (ends exactly on the live totals above). */
  session: () => CurvePoint[];
  week: () => CurvePoint[];
}

function interp(arr: Float64Array, minute: number): number {
  const lo = Math.min(Math.floor(minute), SESSION_MINUTES);
  const hi = Math.min(lo + 1, SESSION_MINUTES);
  const f = minute - lo;
  return arr[lo] + (arr[hi] - arr[lo]) * f;
}

/** The session minute (0..390) for an instant on the demo day. */
export function sessionMinute(day: string, nowMs: number): number {
  const open = sessionOpenMs(day);
  return Math.min(Math.max((nowMs - open) / 60_000, 0), SESSION_MINUTES);
}

/** The demo's trading day for an instant: the latest session that has started. */
export function demoDayFor(now: Date): string {
  return lastSessionDate(now);
}

const D = (n: number | string): Decimal => new Decimal(n);

/** Build the full scene (export + live quotes + chart builders) for `now`. */
export function buildScene(spec: PersonaSpec, now: Date): DemoScene {
  const day = demoDayFor(now);
  const h = buildHistory(spec, day);
  const nowMs = now.getTime();
  const minute = sessionMinute(day, nowMs);
  const n = h.dates.length;
  const insts = spec.instruments;
  const last = n - 1;
  const dayLabel = h.prevDay;
  const closeIso = (iso: string): string => new Date(sessionCloseMs(iso)).toISOString().replace(".000Z", "+00:00");

  // --- Live quotes + FX ---------------------------------------------------
  const fxNow = interp(h.dayPaths.fx, minute);
  const fxOpen = h.dayPaths.fx[0];
  const fxRates: FxRates = { base: "EUR", rates: { USD: D(fxNow.toFixed(5)) } };
  const quotes = new Map<string, Quote>();
  insts.forEach((s, j) => {
    if (s.moneyMarket) return;
    if (s.priceType === "nav") {
      // A fund publishes once a day, so the freshest NAV is yesterday's.
      quotes.set(s.symbol, {
        symbol: s.symbol, price: D(h.prices[j][last]), previousClose: D(h.prices[j][last - 1]), currency: s.currency,
        at: nowMs - 20_000, priceTime: null, valueDate: h.prevDay,
      });
      return;
    }
    const seen = nowMs - ((hashString(s.symbol) % 25) + 3) * 1000;
    quotes.set(s.symbol, {
      symbol: s.symbol, price: D(interp(h.dayPaths.price[j], minute).toFixed(h.prices[j][last] >= 20 ? 2 : 4)), previousClose: D(h.prices[j][last]), currency: s.currency,
      at: seen, priceTime: seen, valueDate: day, marketOpen: true,
    });
  });

  // --- Holdings -------------------------------------------------------------
  const holdings: ExportHolding[] = insts.map((s, j) => {
    const ho = h.holders[j];
    const base: ExportHolding = {
      symbol: s.symbol, name: s.name, asset_class: s.assetClass, category: s.category, broker: s.broker, account: s.account,
      native_currency: s.currency, shares: ho.shares.toFixed(4), cost_basis_native: fmt2(ho.costNative),
      cost_basis_eur: fmt2(ho.costEur), cost_basis_usd: fmt2(ho.costUsd), cumulative_dividends_cash_native: "0.00",
      price_symbol: s.symbol, price_type: s.priceType,
      last_known_price_native: s.moneyMarket ? "1.00" : h.prices[j][last].toFixed(4),
      cashflows: ho.flows.map((f): ExportCashflow => ({ date: f.date, amount: fmt2(f.eur), amount_usd: fmt2(f.usd) })),
    };
    if (s.moneyMarket) return { ...base, is_money_market: true };
    return {
      ...base,
      last_price_date: h.prevDay, last_price_time: closeIso(h.prevDay),
      previous_close_native: h.prices[j][last - 1].toFixed(4), previous_close_date: h.dates[last - 1],
    };
  });

  // --- Live valuation (Decimal, through the app's own `convert`) -------------
  const valueOf = (j: number): { eur: Decimal; usd: Decimal } => {
    const s = insts[j];
    const q = quotes.get(s.symbol);
    const price = s.moneyMarket ? D(1) : (q?.price ?? D(0));
    const native = D(holdings[j].shares).times(price);
    return { eur: convert(native, s.currency, "EUR", fxRates) ?? D(0), usd: convert(native, s.currency, "USD", fxRates) ?? D(0) };
  };
  const cashRows: ExportCash[] = [{ account_label: "Cash", broker: BROKER, native_currency: "EUR", balance_native: fmt2(h.cashEur[last]) }];
  if (h.cashUsd[last] > 0) cashRows.push({ account_label: "USD cash", broker: BROKER, native_currency: "USD", balance_native: fmt2(h.cashUsd[last]) });
  let totalEur = D(0);
  let totalUsd = D(0);
  const values = insts.map((_, j) => valueOf(j));
  for (const v of values) {
    totalEur = totalEur.plus(v.eur);
    totalUsd = totalUsd.plus(v.usd);
  }
  let cashNowEur = D(0);
  for (const c of cashRows) {
    const eur = convert(D(c.balance_native), c.native_currency, "EUR", fxRates) ?? D(0);
    const usd = convert(D(c.balance_native), c.native_currency, "USD", fxRates) ?? D(0);
    cashNowEur = cashNowEur.plus(eur);
    totalEur = totalEur.plus(eur);
    totalUsd = totalUsd.plus(usd);
  }

  // --- Portfolio cashflows, deposits ------------------------------------------
  const portfolioCashflows: ExportCashflow[] = h.deposits.map((dep) => ({ date: dep.date, amount: fmt2(-dep.eur), amount_usd: fmt2(-dep.usd) }));
  const netContribEur = h.deposits.reduce((a, dep) => a.plus(D(fmt2(dep.eur))), D(0));
  const netContribUsd = h.deposits.reduce((a, dep) => a.plus(D(fmt2(dep.usd))), D(0));
  const incomeTotalEur = Array.from(h.income.values()).reduce((a, b) => a + b.div + b.int, 0);
  const incomeTotalUsd = Array.from(h.income.values()).reduce((a, b) => a + b.divUsd + b.intUsd, 0);
  const gainEur = totalEur.minus(netContribEur);

  // --- Attribution (whole life; sums to total gain) ----------------------------
  const attribution: ExportAttributionRow[] = [];
  let pnlSum = D(0);
  insts.forEach((s, j) => {
    const ho = h.holders[j];
    const pnl = values[j].eur.minus(D(fmt2(ho.costEur))).plus(D(fmt2(ho.incomeEur))).plus(D(fmt2(ho.realizedEur)));
    pnlSum = pnlSum.plus(pnl);
    attribution.push({
      instrument_id: j + 1, symbol: s.symbol, start_value: "0.00", end_value: values[j].eur.toFixed(2),
      net_contribution: fmt2(ho.costEur), absolute_pnl: pnl.toFixed(2), pct_of_total_return: gainEur.greaterThan(0) ? pnl.dividedBy(gainEur).toFixed(4) : "0",
    });
  });
  // Cash is the remainder: the EUR/USD drift on the USD cash balance (+ rounding).
  const cashPnl = gainEur.minus(pnlSum);
  attribution.push({
    instrument_id: insts.length + 1, symbol: "Cash", start_value: "0.00", end_value: cashNowEur.toFixed(2),
    net_contribution: fmt2(h.usdCashReceivedEur), absolute_pnl: cashPnl.toFixed(2),
    pct_of_total_return: gainEur.greaterThan(0) ? cashPnl.dividedBy(gainEur).toFixed(4) : "0",
  });

  // --- Periods -----------------------------------------------------------------
  const idxBefore = (iso: string): number => {
    let lo = -1;
    for (let i = 0; i < n; i += 1) {
      if (h.dates[i] < iso) lo = i;
      else break;
    }
    return lo;
  };
  const returns = (vals: number[], flows: number[]): number[] => {
    const out: number[] = [0];
    for (let d = 1; d < n; d += 1) out.push((vals[d] - flows[d]) / vals[d - 1] - 1);
    return out;
  };
  const rEur = returns(h.valueEur, h.flowEur);
  const rUsd = returns(h.valueUsd, h.flowUsd);
  const periodRows = (keyLen: 4 | 7): ExportPeriodRow[] => {
    const labels = keyLen === 7
      ? monthLabels(h.dates[0].slice(0, 7), day.slice(0, 7))
      : monthLabels(h.dates[0].slice(0, 4) + "-01", day.slice(0, 4) + "-01").filter((l) => l.endsWith("-01")).map((l) => l.slice(0, 4));
    return labels.map((label) => {
      const startIso = keyLen === 7 ? `${label}-01` : `${label}-01-01`;
      const openIdx = idxBefore(startIso);
      const inPeriod: number[] = [];
      for (let i = 0; i < n; i += 1) if (h.dates[i].startsWith(label)) inPeriod.push(i);
      const closeIdx = inPeriod.length > 0 ? inPeriod[inPeriod.length - 1] : openIdx;
      let contribEur = 0, contribUsd = 0, divEur = 0, divUsd = 0, intEur = 0, intUsd = 0;
      for (const i of inPeriod) {
        contribEur += h.flowEur[i];
        contribUsd += h.flowUsd[i];
      }
      for (const [month, b] of h.income) {
        if (!month.startsWith(label)) continue;
        divEur += b.div; divUsd += b.divUsd; intEur += b.int; intUsd += b.intUsd;
      }
      const openEur = openIdx >= 0 ? h.valueEur[openIdx] : 0;
      const openUsd = openIdx >= 0 ? h.valueUsd[openIdx] : 0;
      const closeEur = closeIdx >= 0 ? h.valueEur[closeIdx] : 0;
      const closeUsd = closeIdx >= 0 ? h.valueUsd[closeIdx] : 0;
      const chain = (rs: number[]): number => inPeriod.reduce((a, i) => a * (1 + rs[i]), 1) - 1;
      const hasGrowth = inPeriod.length > 0 && openEur + contribEur > 0;
      return {
        label, contributions_eur: fmt2(contribEur), dividends_eur: fmt2(divEur), interest_eur: fmt2(intEur),
        net_flow_eur: fmt2(contribEur + divEur + intEur), opening_value_eur: fmt2(openEur), closing_value_eur: fmt2(closeEur),
        growth_pct: hasGrowth ? chain(rEur).toFixed(6) : null,
        display_currency: "USD", contributions_display: fmt2(contribUsd), dividends_display: fmt2(divUsd), interest_display: fmt2(intUsd),
        net_flow_display: fmt2(contribUsd + divUsd + intUsd), opening_value_display: fmt2(openUsd), closing_value_display: fmt2(closeUsd),
        growth_pct_display: hasGrowth ? chain(rUsd).toFixed(6) : null,
      };
    });
  };
  const monthStartIso = `${day.slice(0, 7)}-01`;
  const yearStartIso = `${day.slice(0, 4)}-01-01`;
  const mIdx = idxBefore(monthStartIso);
  const yIdx = idxBefore(yearStartIso);
  const openingsFor = (idx: number): { eur: string; usd: string } => ({ eur: fmt2(idx >= 0 ? h.valueEur[idx] : 0), usd: fmt2(idx >= 0 ? h.valueUsd[idx] : 0) });
  const holdingOpenings: Record<string, { month_start_value_eur: string; year_start_value_eur: string; month_start_value_usd: string; year_start_value_usd: string }> = {};
  insts.forEach((s, j) => {
    const at = (idx: number): { eur: string; usd: string } => {
      if (idx < 0) return { eur: "0.00", usd: "0.00" };
      const native = h.shares[idx][j] * h.prices[j][idx];
      const rate = h.fx[idx];
      return { eur: fmt2(s.currency === "USD" ? native / rate : native), usd: fmt2(s.currency === "USD" ? native : native * rate) };
    };
    const m = at(mIdx);
    const y = at(yIdx);
    holdingOpenings[s.symbol] = { month_start_value_eur: m.eur, year_start_value_eur: y.eur, month_start_value_usd: m.usd, year_start_value_usd: y.usd };
  });

  // --- Equity curve + scalars ----------------------------------------------------
  const curve = h.dates.map((date, d) => ({
    date, portfolio_value: fmt2(h.valueEur[d]), portfolio_value_usd: fmt2(h.valueUsd[d]),
    cumulative_contributions: fmt2(h.cumEur[d]), benchmark_value: h.bench[d].toFixed(4),
  }));
  // Today's return and benchmark move, from the live totals (no flows today).
  const liveEur = totalEur.toNumber();
  const liveUsd = totalUsd.toNumber();
  const benchNow = interp(h.dayPaths.bench, minute);
  const rTodayEur = liveEur / h.valueEur[last] - 1;
  const rTodayUsd = liveUsd / h.valueUsd[last] - 1;
  const benchUsdReturns: number[] = [];
  const benchEurReturns: number[] = [];
  for (let d = 1; d < n; d += 1) {
    benchUsdReturns.push(h.bench[d] / h.bench[d - 1] - 1);
    benchEurReturns.push((h.bench[d] / h.fx[d]) / (h.bench[d - 1] / h.fx[d - 1]) - 1);
  }
  benchUsdReturns.push(benchNow / h.bench[last] - 1);
  benchEurReturns.push((benchNow / fxNow) / (h.bench[last] / h.fx[last]) - 1);
  const spanDays = (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${h.dates[0]}T12:00:00Z`)) / DAY_MS;
  const sEur = riskScalars([...rEur.slice(1), rTodayEur], benchEurReturns, spanDays);
  const sUsd = riskScalars([...rUsd.slice(1), rTodayUsd], benchUsdReturns, spanDays);
  const flowsEur: Cashflow[] = h.deposits.map((dep) => ({ date: dep.date, amount: D(fmt2(-dep.eur)) }));
  const flowsUsd: Cashflow[] = h.deposits.map((dep) => ({ date: dep.date, amount: D(fmt2(-dep.usd)) }));
  const xirrEur = xirr(flowsEur, day, { terminalValue: totalEur });
  const xirrUsd = xirr(flowsUsd, day, { terminalValue: totalUsd });
  const s6 = (x: number): string => (Number.isFinite(x) ? x.toFixed(6) : "0");
  const dp = (x: Decimal | null): string => (x === null ? "0" : x.toFixed(6));

  // --- Deposit records + summary ---------------------------------------------------
  const depositRows: ExportDepositRecord[] = h.deposits.map((dep, i) => ({
    id: i + 1, date: dep.date, account: "Taxable", kind: "contribution", amount_eur: fmt2(dep.eur), amount_usd: fmt2(dep.usd),
    amount_native: fmt2(dep.eur), currency: "EUR", description: dep.description,
  }));
  const sumDeposits = (pred: (date: string) => boolean): { eur: string; usd: string } => {
    let e = 0, u = 0;
    for (const dep of h.deposits) if (pred(dep.date)) { e += dep.eur; u += dep.usd; }
    return { eur: fmt2(e), usd: fmt2(u) };
  };
  const dTotal = sumDeposits(() => true);
  const dYtd = sumDeposits((date) => date >= yearStartIso);
  const dMtd = sumDeposits((date) => date >= monthStartIso);

  // --- Transactions (newest first) ----------------------------------------------------
  const ledger = [...h.txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const transactions: ExportTransactionRecord[] = ledger
    .map((t, i): ExportTransactionRecord => ({
      id: i + 1, date: t.date, account: t.account, kind: t.kind, symbol: t.symbol,
      quantity: t.quantity === null ? null : String(t.quantity), price_native: t.price === null ? null : t.price.toFixed(4),
      fees_native: t.fees === null ? null : fmt2(t.fees), gross_native: t.gross === null ? null : fmt2(t.gross),
      net_native: fmt2(t.net), net_eur: fmt2(t.netEur), net_usd: fmt2(t.netUsd), source: t.source,
    }))
    .reverse();

  // --- Fingerprint (cheap digest of the exported history) -------------------------------
  let digest = 0;
  curve.forEach((p) => {
    digest = (Math.imul(digest, 31) + hashString(`${p.date}:${Math.round(Number(p.portfolio_value))}`)) >>> 0;
  });

  const nonMm = insts.filter((s) => !s.moneyMarket);
  const marketCount = nonMm.filter((s) => s.priceType === "market").length;
  const navCount = nonMm.filter((s) => s.priceType === "nav").length;
  const coverage = `${marketCount}/${marketCount} live${navCount > 0 ? `, ${navCount} ${navCount === 1 ? "NAV" : "NAVs"} expected tonight` : ""} · FX live`;

  const generatedAtMs = nowMs - 25 * 60_000;
  const data: MobileExport = {
    meta: {
      schema_version: 3, app_version: "demo", generated_at: new Date(generatedAtMs).toISOString().replace(".000Z", "+00:00"),
      as_of: day, display_currency: "EUR", fx_pivot: "EUR", fx_rate_eur_usd: fxNow.toFixed(5),
      investment_amount_eur: String(spec.monthlyEur), currency_note: "Sample data — not a real portfolio.",
    },
    holdings,
    portfolio_cashflows: portfolioCashflows,
    portfolio_metrics: {
      net_contributions_eur: netContribEur.toFixed(2), net_contributions_usd: netContribUsd.toFixed(2),
      dividends_cash_eur: "0.00", dividends_cash_usd: "0.00",
      dividends_income_eur: fmt2(incomeTotalEur), dividends_income_usd: fmt2(incomeTotalUsd),
    },
    cash: cashRows,
    period_openings: {
      month_start_value_eur: openingsFor(mIdx).eur, year_start_value_eur: openingsFor(yIdx).eur,
      month_start_value_usd: openingsFor(mIdx).usd, year_start_value_usd: openingsFor(yIdx).usd,
      holdings: holdingOpenings,
    },
    monthly: { rows: periodRows(7) },
    yearly: { rows: periodRows(4) },
    analytics: {
      as_of: day, start: h.dates[0], currency: "EUR",
      cagr: s6(sEur.cagr), twr: s6(sEur.twr), xirr: dp(xirrEur),
      volatility: s6(sEur.volatility), sharpe: s6(sEur.sharpe), sortino: s6(sEur.sortino),
      max_drawdown: s6(sEur.maxDrawdown), calmar: s6(sEur.calmar), ulcer: s6(sEur.ulcer),
      var_95: s6(sEur.var95), cvar_95: s6(sEur.cvar95), skew: s6(sEur.skew), kurtosis: s6(sEur.kurtosis),
      beta: s6(sEur.beta), alpha: s6(sEur.alpha),
      cagr_usd: s6(sUsd.cagr), twr_usd: s6(sUsd.twr), xirr_usd: dp(xirrUsd),
      volatility_usd: s6(sUsd.volatility), sharpe_usd: s6(sUsd.sharpe), sortino_usd: s6(sUsd.sortino),
      max_drawdown_usd: s6(sUsd.maxDrawdown), calmar_usd: s6(sUsd.calmar), ulcer_usd: s6(sUsd.ulcer),
      var_95_usd: s6(sUsd.var95), cvar_95_usd: s6(sUsd.cvar95), skew_usd: s6(sUsd.skew), kurtosis_usd: s6(sUsd.kurtosis),
      beta_usd: s6(sUsd.beta), alpha_usd: s6(sUsd.alpha),
      risk_free_rate: String(RISK_FREE), risk_free_symbol: "US3M", benchmark_symbol: DEMO_BENCHMARK.symbol,
      curve, attribution,
    },
    deposits: {
      summary: {
        total_contrib_eur: dTotal.eur, ytd_contrib_eur: dYtd.eur, mtd_contrib_eur: dMtd.eur,
        total_contrib_usd: dTotal.usd, ytd_contrib_usd: dYtd.usd, mtd_contrib_usd: dMtd.usd,
      },
      rows: depositRows,
    },
    target_allocations: [
      {
        name: "Core plan", active: true, allow_sell: false, display_currency: "EUR",
        items: insts.map((s, j) => ({
          instrument_id: j + 1, symbol: s.symbol, weight_pct: ((s.weight / insts.reduce((a, x) => a + x.weight, 0)) * 100).toFixed(2), no_buy: s.moneyMarket === true,
        })),
      },
    ],
    history_fingerprint: { days: n, last_date: dayLabel, digest: digest.toString(16).padStart(8, "0") },
    transactions: { rows: transactions },
  };

  // --- Live chart builders ------------------------------------------------------------------
  const valueAt = (di: number, priceAt: (j: number) => number, rate: number): { eur: number; usd: number } => {
    let eur = h.cashEur[di] + h.cashUsd[di] / rate;
    let usd = h.cashUsd[di] + h.cashEur[di] * rate;
    insts.forEach((s, j) => {
      const native = h.shares[di][j] * priceAt(j);
      eur += s.currency === "USD" ? native / rate : native;
      usd += s.currency === "USD" ? native : native * rate;
    });
    return { eur, usd };
  };
  const pt = (t: number, v: { eur: number; usd: number }): CurvePoint => ({ t, valueEur: D(v.eur.toFixed(2)), valueUsd: D(v.usd.toFixed(2)) });
  const session = (): CurvePoint[] => {
    const open = sessionOpenMs(day);
    const points: CurvePoint[] = [];
    const whole = Math.floor(minute);
    const livePrice = (m: number) => (j: number): number => (insts[j].priceType === "nav" ? h.prices[j][last] : interp(h.dayPaths.price[j], m));
    for (let m = 0; m <= whole; m += 1) {
      points.push(pt(open + m * 60_000, valueAt(last, livePrice(m), h.dayPaths.fx[m])));
    }
    // The tip is the headline itself, so the curve ends exactly on the live total.
    points.push({ t: nowMs, valueEur: totalEur, valueUsd: totalUsd });
    return points;
  };
  const week = (): CurvePoint[] => {
    const sessions = recentTradingSessions(5, new Date(nowMs));
    const points: CurvePoint[] = [];
    for (const s of sessions) {
      if (s === day) continue;
      const di = h.dates.indexOf(s);
      if (di < 1) continue;
      const open = sessionOpenMs(s);
      const rng = new Rng(hashString(`${spec.id}|${s}|wk`));
      const steps = 13;
      const walk: number[][] = insts.map(() => {
        const w = [0];
        for (let k = 1; k <= steps; k += 1) w.push(w[k - 1] + rng.normal() / Math.sqrt(steps));
        return w.map((x, k) => x - (k / steps) * w[steps]);
      });
      for (let k = 0; k <= steps; k += 1) {
        const f = k / steps;
        const price = (j: number): number => {
          const s2 = insts[j];
          const close = h.prices[j][di];
          if (s2.moneyMarket) return 1;
          if (s2.priceType === "nav") return close;
          const prev = h.prices[j][di - 1];
          return prev * Math.exp(Math.log(close / prev) * f + (s2.vol / Math.sqrt(252)) * 0.8 * walk[j][k]);
        };
        const rate = h.fx[di - 1] + (h.fx[di] - h.fx[di - 1]) * f;
        points.push(pt(open + Math.round(f * SESSION_MINUTES) * 60_000, valueAt(di, price, rate)));
      }
    }
    // Today: a point every 5 minutes, ending on the live tip.
    const open = sessionOpenMs(day);
    const todayPrice = (m: number) => (j: number): number => (insts[j].priceType === "nav" ? h.prices[j][last] : interp(h.dayPaths.price[j], m));
    for (let m = 0; m < minute; m += 5) points.push(pt(open + m * 60_000, valueAt(last, todayPrice(m), interp(h.dayPaths.fx, m))));
    points.push({ t: nowMs, valueEur: totalEur, valueUsd: totalUsd });
    return points;
  };

  return {
    history: h, nowMs, minute, data, quotes, fx: fxRates, fxPrevEurUsd: D(h.fx[last].toFixed(5)), fxSessionOpen: D(fxOpen.toFixed(5)),
    coverage, totalEur, totalUsd, session, week,
  };
}
