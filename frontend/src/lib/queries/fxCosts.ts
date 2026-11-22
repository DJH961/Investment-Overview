import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";
import type { RateRange } from "./currencyRate";

type S = components["schemas"];

/**
 * `GET /api/fx-conversions/costs?range=` (7.3): what converting costs you, per
 * reporting currency in one cached entry (a currency switch is a `select`). The EUR
 * side is euros paid over the ECB daily reference; the USD side is the dollars you did
 * not get, each computed at its own conversion's fixing. Every figure is the server's.
 */
export type FxCostsDto = S["CostsOut"];
export type FxCostSummaryDto = S["CostSummaryOut"];
export type FxCostRowDto = S["CostRowOut"];
export type FxCostYearDto = S["CostYearOut"];
export type FxCostProviderDto = S["CostProviderOut"];

type Both<T> = { EUR: T; USD: T };

export const fxCostsQuery = (ccy: ReportingCurrency, range: RateRange) =>
  queryOptions({
    // under "fx-conversions" so a conversion write refreshes it (see invalidation.ts)
    queryKey: ["fx-conversions", "costs", range],
    queryFn: ({ signal }) => api<Both<FxCostsDto>>(`/api/fx-conversions/costs?range=${range}`, { signal }),
    select: (d: Both<FxCostsDto>) => d[ccy],
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

export function useFxCosts(ccy: ReportingCurrency, range: RateRange) {
  return useQuery(fxCostsQuery(ccy, range));
}
