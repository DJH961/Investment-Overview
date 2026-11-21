/**
 * Look up any instrument (7.1, docs/v7_1_contract.md › Lookup). Nothing here touches
 * the ledger: the server keeps lookups in a short in-memory cache only.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { HoldingRange } from "./holding-detail";

type S = components["schemas"];
export type LookupResultDto = S["LookupHit"];
export type LookupSearchDto = S["LookupSearchResponse"];
export type LookupQuoteDto = S["LookupQuote"];
/** Each point carries its own EUR/USD rate (dollars per euro): one instant, one rate. */
export type LookupHistoryDto = S["LookupHistory"];

export function useLookupSearch(q: string) {
  const query = q.trim();
  return useQuery<LookupSearchDto>({
    queryKey: ["lookup", "search", query],
    enabled: query.length >= 1,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
    queryFn: ({ signal }) => api<LookupSearchDto>(`/api/lookup/search?q=${encodeURIComponent(query)}`, { signal }),
  });
}

export function useLookupQuote(symbol: string) {
  return useQuery<LookupQuoteDto>({
    queryKey: ["lookup", "quote", symbol],
    enabled: symbol !== "",
    staleTime: 60_000,
    queryFn: ({ signal }) => api<LookupQuoteDto>(`/api/lookup/${encodeURIComponent(symbol)}/quote`, { signal }),
  });
}

export function useLookupHistory(symbol: string, range: HoldingRange) {
  return useQuery<LookupHistoryDto>({
    queryKey: ["lookup", "history", symbol, range],
    enabled: symbol !== "",
    staleTime: 5 * 60_000,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === symbol ? prev : undefined),
    queryFn: ({ signal }) =>
      api<LookupHistoryDto>(`/api/lookup/${encodeURIComponent(symbol)}/history?range=${range}`, { signal }),
  });
}
