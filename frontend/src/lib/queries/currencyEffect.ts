import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";
import type { RateRange } from "./currencyRate";

type S = components["schemas"];

/**
 * `GET /api/currency/effect/both?range=` (v7.2): the Currency page's Impact section.
 * Both currencies in one cached entry (a currency switch is a `select`, no request);
 * each side is built in its own currency on the server. The live stream refreshes it
 * with the rest of the `currency` root (see `invalidation.ts`).
 */
export type CurrencyEffectDto = S["CurrencyEffectOut"];
export type EffectPointDto = S["EffectPoint"];
export type EffectBarDto = S["EffectBar"];
export type EffectGridRowDto = S["EffectGridRow"];
export type EffectRecordsDto = S["EffectRecords"];
export type EffectRecordDto = S["EffectRecord"];
export type HoldingEffectDto = S["HoldingEffect"];
export type SessionSplitDto = S["SessionSplit"];
export type EffectBuysDto = S["EffectBuys"];
export type EffectStatDto = S["EffectStat"];
export type EffectBridgeDto = S["EffectBridge"];

export type RangeWindowDto = S["RangeWindow"];
export type OtherLensDto = S["OtherLens"];

/**
 * `1d|1w|1m|3m|ytd|1y|3y|5y|10y|all|max` or a calendar year: the page range as is
 * (7.3.1). All is your investing window, Max the whole history with the part before
 * you started as context (`window.context_until`); the server resolves both.
 */
export type EffectRange = RateRange | string;

export const currencyEffectQuery = (range: EffectRange) =>
  queryOptions({
    queryKey: ["currency", "effect", range],
    queryFn: ({ signal }) =>
      api<{ EUR: CurrencyEffectDto; USD: CurrencyEffectDto }>(`/api/currency/effect/both?range=${encodeURIComponent(range)}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

/** Both sides of the same cached entry, for panels that set EUR next to USD. */
export function useCurrencyEffectBoth(range: EffectRange) {
  return useQuery(currencyEffectQuery(range));
}

export function useCurrencyEffect(range: EffectRange, ccy: ReportingCurrency) {
  return useQuery({ ...currencyEffectQuery(range), select: (d) => d[ccy] });
}
