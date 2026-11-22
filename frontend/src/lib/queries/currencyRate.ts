import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";

type S = components["schemas"];

/**
 * `GET /api/currency/rate-history?range=` (v7.2): the rate chart on the Currency page.
 * Same payload for both reporting currencies. `rate` is USD per 1 EUR; `inverse` is
 * one dollar in euros, computed on the server. Fractions: 0.01 = 1 %.
 */
export type RateHistoryDto = S["RateHistoryOut"];
export type RatePointDto = S["RateHistoryPoint"];
export type RateTrendDto = S["RateTrend"];
export type RateMarkerDto = S["ConversionMarker"];
export type RateRange = RateHistoryDto["range"];

export const RATE_RANGES: readonly RateRange[] = ["1d", "1w", "1m", "3m", "ytd", "1y", "all", "5y", "10y", "max"];

export const RATE_RANGE_LABELS: Record<RateRange, string> = {
  "1d": "1D",
  "1w": "1W",
  "1m": "1M",
  "3m": "3M",
  ytd: "YTD",
  "1y": "1Y",
  all: "All",
  "5y": "5Y",
  "10y": "10Y",
  max: "Max",
};

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
