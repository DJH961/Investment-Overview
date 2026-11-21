import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";

/**
 * `GET /api/currency/rate-history?range=` (v7.2): the EUR/USD chart on the Currency page.
 * Same payload for both reporting currencies. `rate` is USD per 1 EUR; `inverse` is the
 * dollar priced in euros (EUR per 1 USD), computed on the server. Fractions: 0.01 = 1 %.
 *
 * Local types until `api-types.ts` is regenerated from the backend lane.
 */
export const RATE_RANGES = ["1d", "1w", "1m", "3m", "ytd", "1y", "5y", "10y", "max"] as const;
export type RateRange = (typeof RATE_RANGES)[number];

export const RATE_RANGE_LABELS: Record<RateRange, string> = {
  "1d": "1D",
  "1w": "1W",
  "1m": "1M",
  "3m": "3M",
  ytd: "YTD",
  "1y": "1Y",
  "5y": "5Y",
  "10y": "10Y",
  max: "Max",
};

export interface RatePointDto {
  t: string;
  rate: string;
  inverse: string;
}

export interface RateTrendDto {
  direction: "dollar_up" | "dollar_down" | "sideways";
  since: string | null;
  since_change_pct: string | null;
  vs_ma200: "above" | "below" | null;
  normal: "normal" | "large" | "unusual";
  move_pct: string;
  typical_move_pct: string;
  move_percentile: string;
  window_days: number;
}

export interface RateMarkerDto {
  date: string;
  rate: string;
  amount_from: string;
  from_ccy: string;
  to_ccy: string;
  kind: "above_reference" | "below_reference" | null;
  conversion_id: number;
}

export interface RateHistoryDto {
  range: RateRange;
  granularity: "intraday" | "daily" | "weekly";
  as_of: string;
  source: string;
  points: RatePointDto[];
  ma200: RatePointDto[];
  avg_rate: { rate: string; inverse: string } | null;
  low: RatePointDto | null;
  high: RatePointDto | null;
  change: { start_rate: string; end_rate: string; rate_pct: string; inverse_pct: string } | null;
  trend: RateTrendDto | null;
  percentiles: { since_start: string | null; y5: string | null; y10: string | null; since_1999: string | null } | null;
  markers: RateMarkerDto[];
}

export const rateHistoryQuery = (range: RateRange) =>
  queryOptions({
    queryKey: ["currency", "rate-history", range],
    queryFn: ({ signal }) => api<RateHistoryDto>(`/api/currency/rate-history?range=${range}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

export function useRateHistory(range: RateRange) {
  return useQuery(rateHistoryQuery(range));
}
