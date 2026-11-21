/**
 * The 7.1 holding deep-dive endpoints (docs/v7_1_contract.md), on the generated API
 * types. Money fields are decimal strings, ratios fractions, times ISO. The client
 * never derives a return from these: it shows them, sums them (linear) or converts
 * one instant at the rate sent with it.
 */
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
export type HoldingPeeksDto = { peeks: Record<string, HoldingPeekDto> };

const PEEK_STALE_MS = 60_000;

export const holdingPeekQueryKey = (instrumentId: number) => ["holdings", "peek", instrumentId] as const;

const fetchHoldingPeek = (instrumentId: number, signal?: AbortSignal) =>
  api<HoldingPeekDto>(`/api/holdings/${instrumentId}/peek`, { signal });

/** The list row's peek: fetched when opened unless already preloaded. */
export function useHoldingPeek(instrumentId: number, enabled: boolean) {
  return useQuery<HoldingPeekDto>({
    queryKey: holdingPeekQueryKey(instrumentId),
    enabled,
    staleTime: PEEK_STALE_MS,
    queryFn: ({ signal }) => fetchHoldingPeek(instrumentId, signal),
  });
}

/** Warm one row's peek on hover/focus before a click arrives. */
export function prefetchHoldingPeek(queryClient: QueryClient, instrumentId: number): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: holdingPeekQueryKey(instrumentId),
    staleTime: PEEK_STALE_MS,
    queryFn: ({ signal }) => fetchHoldingPeek(instrumentId, signal),
  });
}

/**
 * Quietly preload every held instrument's peek once the Holdings list has
 * rendered and the browser hits idle, populating individual peek cache entries.
 */
export function usePrefetchHoldingPeeks(enabled: boolean): void {
  const queryClient = useQueryClient();
  const [idleReady, setIdleReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setIdleReady(true);
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      const handle = w.requestIdleCallback(markReady, { timeout: 150 });
      return () => {
        cancelled = true;
        w.cancelIdleCallback?.(handle);
        setIdleReady(false);
      };
    }
    const timer = window.setTimeout(markReady, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setIdleReady(false);
    };
  }, [enabled]);

  useQuery<HoldingPeeksDto>({
    queryKey: ["holdings", "peeks"],
    enabled: enabled && idleReady,
    staleTime: PEEK_STALE_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await api<HoldingPeeksDto>("/api/holdings/peeks", { signal });
      for (const [id, peek] of Object.entries(res.peeks)) {
        const instrumentId = Number(id);
        if (Number.isFinite(instrumentId)) {
          queryClient.setQueryData(holdingPeekQueryKey(instrumentId), peek);
        }
      }
      return res;
    },
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
