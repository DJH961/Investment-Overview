import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";
import type { RateRange } from "./currencyRate";

type S = components["schemas"];

/**
 * The Currency page's "The dollar" and "What if" sections (v7.2). Both reporting
 * currencies in one cached entry (`/both`), so a currency switch is a `select`, no
 * request. Every figure is the server's; each side names the quote it shows
 * (`quote.field`: `inverse` = one dollar in euros, `rate` = EUR/USD).
 */
export type DollarDto = S["DollarOut"];
export type DollarQuoteDto = S["DollarQuote"];
export type RateValueDto = S["RateValue"];
export type RateChangeDto = S["RateChange"];
export type NormalRangeDto = S["NormalRange"];
export type RollingSeriesDto = S["RollingSeries"];
export type DollarStatDto = S["DollarStat"];
export type ScenariosDto = S["ScenariosOut"];
export type ScenarioRowDto = S["ScenarioRow"];
export type ScenarioMarkDto = S["ScenarioMark"];
export type ScenarioStatDto = S["ScenarioStat"];

type Both<T> = { EUR: T; USD: T };

export const dollarQuery = (ccy: ReportingCurrency, range: RateRange) =>
  queryOptions({
    queryKey: ["currency", "dollar", range],
    queryFn: ({ signal }) => api<Both<DollarDto>>(`/api/currency/dollar/both?range=${range}`, { signal }),
    select: (d: Both<DollarDto>) => d[ccy],
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

export function useDollar(ccy: ReportingCurrency, range: RateRange) {
  return useQuery(dollarQuery(ccy, range));
}

/** Both sides of the cached `/both` entry, for panels that set EUR next to USD. */
export function useDollarBoth(range: RateRange) {
  return useQuery({ ...dollarQuery("EUR", range), select: (d: Both<DollarDto>) => d });
}

export const scenariosQuery =(ccy: ReportingCurrency, range: RateRange = "max") =>
  queryOptions({
    queryKey: ["currency", "scenarios", range],
    queryFn: ({ signal }) => api<Both<ScenariosDto>>(`/api/currency/scenarios/both?range=${range}`, { signal }),
    select: (d: Both<ScenariosDto>) => d[ccy],
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

export function useScenarios(ccy: ReportingCurrency, range: RateRange = "max") {
  return useQuery(scenariosQuery(ccy, range));
}

/** The side of a rate pair this view prints (the server names it in `quote.field`). */
export const quoteOf = (v: RateValueDto | null | undefined, field: DollarQuoteDto["field"]) =>
  v ? (field === "inverse" ? v.inverse : v.rate) : null;

/** The change that goes with the quote shown (`rate` -> `rate_pct`, `inverse` -> `inverse_pct`). */
export const changeOf = (c: RateChangeDto | null | undefined, field: DollarQuoteDto["field"]) =>
  c ? (field === "inverse" ? c.inverse_pct : c.rate_pct) : null;
