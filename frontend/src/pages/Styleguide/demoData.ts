import type { ChartSeries } from "../../components/Chart";

/** Deterministic pseudo random numbers so the styleguide looks the same every visit. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export const DEMO_RANGES = ["1D", "1W", "1M", "1Y", "ALL"] as const;
export type DemoRange = (typeof DEMO_RANGES)[number];

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1, 16, 0, 0);

const SPEC: Record<DemoRange, { n: number; step: number; drift: number; vol: number }> = {
  "1D": { n: 78, step: 5 * 60_000, drift: 0.00002, vol: 0.0012 },
  "1W": { n: 5 * 8, step: 3 * 3_600_000, drift: 0.0002, vol: 0.003 },
  "1M": { n: 30, step: DAY, drift: 0.0009, vol: 0.008 },
  "1Y": { n: 52, step: 7 * DAY, drift: 0.0028, vol: 0.02 },
  ALL: { n: 60, step: 30 * DAY, drift: 0.009, vol: 0.04 },
};

/** Portfolio around EUR 250k with a benchmark line; one gap in the 1M range. */
export function demoSeries(range: DemoRange): ChartSeries[] {
  const { n, step, drift, vol } = SPEC[range];
  const rand = rng(range.length * 7919 + n);
  let v = 250_000;
  let b = 250_000;
  const portfolio: ChartSeries["points"] = [];
  const benchmark: ChartSeries["points"] = [];
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    v *= 1 + drift + (rand() - 0.5) * vol;
    b *= 1 + drift * 0.8 + (rand() - 0.5) * vol * 0.8;
    raw.push(v);
  }
  const scale = 250_000 / raw[raw.length - 1];
  v = 0;
  b = 250_000 * scale;
  for (let i = 0; i < n; i++) {
    const t = NOW - (n - 1 - i) * step;
    const value = raw[i] * scale;
    b *= 1 + drift * 0.8 + (rand() - 0.5) * vol * 0.8;
    const gap = range === "1M" && i >= 12 && i <= 14;
    portfolio.push({ t, v: gap ? null : value });
    benchmark.push({ t, v: b });
  }
  return [
    {
      id: "portfolio",
      label: "Portfolio (EUR)",
      points: portfolio,
      tone: "primary",
    },
    {
      id: "benchmark",
      label: "MSCI World",
      points: benchmark,
      tone: "benchmark",
    },
  ];
}

export interface DemoHolding {
  id: string;
  name: string;
  isin: string;
  value: number;
  returnRatio: number;
  weight: number;
  target: number;
}

export const DEMO_HOLDINGS: DemoHolding[] = [
  {
    id: "vwce",
    name: "Vanguard FTSE All-World",
    isin: "IE00BK5BQT80",
    value: 112_400,
    returnRatio: 0.142,
    weight: 0.45,
    target: 0.5,
  },
  {
    id: "eunl",
    name: "iShares Core MSCI World",
    isin: "IE00B4L5Y983",
    value: 61_250,
    returnRatio: 0.118,
    weight: 0.245,
    target: 0.25,
  },
  {
    id: "eimi",
    name: "iShares Core MSCI EM IMI",
    isin: "IE00BKM4GZ66",
    value: 27_800,
    returnRatio: -0.034,
    weight: 0.111,
    target: 0.1,
  },
  {
    id: "sxrt",
    name: "iShares Core DAX",
    isin: "DE0005933931",
    value: 21_300,
    returnRatio: 0.067,
    weight: 0.085,
    target: 0.05,
  },
  {
    id: "4gld",
    name: "Xetra-Gold",
    isin: "DE000A0S9GB0",
    value: 18_900,
    returnRatio: 0.231,
    weight: 0.076,
    target: 0.05,
  },
  {
    id: "cash",
    name: "Cash",
    isin: "-",
    value: 8_350,
    returnRatio: 0,
    weight: 0.033,
    target: 0.05,
  },
];
