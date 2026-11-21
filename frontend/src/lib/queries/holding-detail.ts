/**
 * The 7.1 holding deep-dive endpoints (docs/v7_1_contract.md), on the generated API
 * types. Money fields are decimal strings, ratios fractions, times ISO. The client
 * never derives a return from these: it shows them, sums them (linear) or converts
 * one instant at the rate sent with it.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";

type S = components["schemas"];

// ---- history ------------------------------------------------------------------------

export type HoldingHistoryV2Dto = S["HoldingHistoryResponse"];
export type HoldingRange = HoldingHistoryV2Dto["range"];
export type HistoryMode = HoldingHistoryV2Dto["mode"];
export type ChartSessionDto = { open: string; close: string; date?: string };
export const HOLDING_RANGES: HoldingRange[] = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"];
/** NAV funds have no intraday price: the server answers 1d / 1w with 422. */
export const NAV_RANGES: HoldingRange[] = ["1m", "3m", "6m", "ytd", "1y", "all"];

export function useHoldingHistoryV2(instrumentId: number | null, range: HoldingRange, mode: HistoryMode) {
  return useQuery<HoldingHistoryV2Dto>({
    queryKey: ["holdings", "history", instrumentId, range, mode],
    enabled: instrumentId !== null,
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === instrumentId && prevQuery?.queryKey[4] === mode ? prev : undefined,
    queryFn: ({ signal }) =>
      api<HoldingHistoryV2Dto>(`/api/holdings/${instrumentId}/history?range=${range}&mode=${mode}`, { signal }),
  });
}

// ---- peek ---------------------------------------------------------------------------

export type HoldingPeekDto = S["HoldingPeekResponse"];

/** The list row's peek: fetched only once the row is opened. */
export function useHoldingPeek(instrumentId: number, enabled: boolean) {
  return useQuery<HoldingPeekDto>({
    queryKey: ["holdings", "peek", instrumentId],
    enabled,
    staleTime: 60_000,
    queryFn: ({ signal }) => api<HoldingPeekDto>(`/api/holdings/${instrumentId}/peek`, { signal }),
  });
}

// ---- twin ---------------------------------------------------------------------------

export type HoldingTwinDto = S["HoldingTwinResponse"];
export type TwinRange = HoldingTwinDto["range"];
export const TWIN_RANGES: TwinRange[] = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y"];

export function useHoldingTwin(instrumentId: number | null, range: TwinRange, enabled = true) {
  return useQuery<HoldingTwinDto>({
    queryKey: ["holdings", "twin", instrumentId, range],
    enabled: enabled && instrumentId !== null,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === instrumentId ? prev : undefined),
    queryFn: ({ signal }) => api<HoldingTwinDto>(`/api/holdings/${instrumentId}/twin?range=${range}`, { signal }),
  });
}

// ---- tranches -----------------------------------------------------------------------

export type HoldingTranchesDto = S["TranchesResponse"];
export type TrancheRowDto = S["TrancheRowOut"];
export type TrancheGroupDto = S["TrancheGroupOut"];
export type TrancheStatus = TrancheRowDto["status"];

export function useHoldingTranches(instrumentId: number | null, enabled = true) {
  return useQuery<HoldingTranchesDto>({
    queryKey: ["holdings", "tranches", instrumentId],
    enabled: enabled && instrumentId !== null,
    queryFn: ({ signal }) => api<HoldingTranchesDto>(`/api/holdings/${instrumentId}/tranches`, { signal }),
  });
}
