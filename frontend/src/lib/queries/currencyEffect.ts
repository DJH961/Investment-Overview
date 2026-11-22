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

/** `1d|1w|1m|3m|ytd|1y|3y|5y|10y|all` or a calendar year. */
export type EffectRange = string;

/**
 * The page range (the rate chart's picker) in the effect endpoint's terms: the same
 * window, except that Max and All (since your first transaction) are your whole time
 * (`all`, the Overview's lifetime returns). A window longer than your history starts at
 * your first transaction; the section says so with the dates the server sends.
 */
export function effectRangeFor(range: RateRange | "all"): EffectRange {
  return range === "max" || range === "all" ? "all" : range;
}

export const currencyEffectQuery = (range: EffectRange) =>
  queryOptions({
    queryKey: ["currency", "effect", range],
    queryFn: ({ signal }) =>
      api<{ EUR: CurrencyEffectDto; USD: CurrencyEffectDto }>(`/api/currency/effect/both?range=${encodeURIComponent(range)}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

export function useCurrencyEffect(range: EffectRange, ccy: ReportingCurrency) {
  return useQuery({ ...currencyEffectQuery(range), select: (d) => d[ccy] });
}
