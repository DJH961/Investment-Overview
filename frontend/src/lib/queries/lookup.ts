/**
 * Look up any instrument (7.1, docs/v7_1_contract.md › Lookup). Typed by hand from the
 * contract until `api-types.ts` is regenerated. Nothing here touches the ledger: the
 * server keeps lookups in a short in-memory cache only.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { ChartSessionDto, HoldingRange } from "./holding-detail";

type DecStr = string;

export interface LookupResultDto {
  symbol: string;
  name: string;
  exchange: string | null;
  type: string | null;
  currency: string | null;
  held_instrument_id: number | null;
}

export interface LookupSearchDto {
  results: LookupResultDto[];
}

export interface LookupQuoteDto {
  symbol: string;
  name: string;
  exchange: string | null;
  type: string | null;
  currency: string;
  price_native: DecStr | null;
  day_change_native: DecStr | null;
  day_pct: DecStr | null;
  captured_at: string | null;
  week52_low: DecStr | null;
  week52_high: DecStr | null;
  /** EUR → USD (dollars per euro) at the quote's instant. */
  fx_eur_usd: DecStr | null;
}

export interface LookupHistoryDto {
  symbol: string;
  currency: string;
  range: HoldingRange;
  x_mode: "date" | "time";
  sessions: ChartSessionDto[];
  /** Each point carries its own EUR/USD rate: one instant, one rate. */
  points: { t: string; price_native: DecStr | null; fx_eur_usd: DecStr | null }[];
}

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
