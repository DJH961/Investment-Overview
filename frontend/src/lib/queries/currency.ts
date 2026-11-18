import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";

type S = components["schemas"];
export type CurrencyDto = S["CurrencyOut"];
export type CurrencyStatDto = S["CurrencyStat"];
export type CurrencyBuysDto = S["CurrencyBuys"];
export type CurrencyRateRangeDto = S["CurrencyRateRange"];

/**
 * The Currency page (7.0: the strip and the Today sub-tab). Both currencies in one
 * cached entry, like the Overview: a currency switch is a `select`, no request. The
 * live stream invalidates it with the overview (see `invalidation.ts`).
 */
export const currencyQuery = (ccy: ReportingCurrency) =>
  queryOptions({
    queryKey: ["currency", "both"],
    queryFn: ({ signal }) => api<{ EUR: CurrencyDto; USD: CurrencyDto }>("/api/currency/both", { signal }),
    select: (d: { EUR: CurrencyDto; USD: CurrencyDto }) => d[ccy],
    placeholderData: keepPreviousData,
  });

export function useCurrency(ccy: ReportingCurrency) {
  return useQuery(currencyQuery(ccy));
}
