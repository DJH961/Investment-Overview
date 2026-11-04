import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";

export type OverviewDto = components["schemas"]["OverviewResponse"];
export type { HoldingRowDto, HoldingsDto } from "./holdings";
export type GraphDto = components["schemas"]["GraphResponse"];
export type AllocationsDto = components["schemas"]["AllocationsResponse"];
export type { HistoryRange, HoldingHistoryDto } from "./holdings";
export { holdingsQuery, useHoldingHistory, useHoldings } from "./holdings";
/** The `/both` routes answer with one entry per reporting currency. */
export type Both<T> = { EUR: T; USD: T };
export type GraphRange = GraphDto["range"];

export const GRAPH_RANGES: GraphRange[] = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"];

/** Decimal strings from the API to numbers, for display only. */
export function toNum(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Query definitions shared by the hooks and the startup prefetch (lib/prefetch.ts). */
export const overviewQuery = (ccy: ReportingCurrency) =>
  queryOptions({
    // Both currencies in one cached entry: a currency switch is a `select`, no request.
    queryKey: ["overview", "both"],
    queryFn: ({ signal }) => api<Both<OverviewDto>>("/api/overview/both", { signal }),
    select: (d: Both<OverviewDto>) => d[ccy],
    placeholderData: keepPreviousData,
  });

/**
 * Intraday ranges move with every tick; daily ranges only change with a new
 * close or a refresh, and the live stream invalidates them then anyway.
 */
export const graphStaleTime = (range: GraphRange) => (range === "1d" || range === "1w" ? 30_000 : 5 * 60_000);

export const graphQuery = (range: GraphRange, ccy: ReportingCurrency) =>
  queryOptions({
    queryKey: ["graphs", range, "both"],
    queryFn: ({ signal }) => api<Both<GraphDto>>(`/api/graphs/${range}/both`, { signal }),
    select: (d: Both<GraphDto>) => d[ccy],
    staleTime: graphStaleTime(range),
  });

export function useOverview(ccy: ReportingCurrency) {
  return useQuery(overviewQuery(ccy));
}

export function useGraph(range: GraphRange, ccy: ReportingCurrency) {
  return useQuery({
    ...graphQuery(range, ccy),
    // A range switch keeps the old curve until the new one lands (the select is per currency).
    placeholderData: keepPreviousData,
  });
}

/** Remember the Overview range on the server (market-aware default). Fire and forget. */
export function rememberGraphRange(range: GraphRange): void {
  api("/api/graphs/range", { method: "PUT", body: { range } }).catch(() => undefined);
}

export const allocationsQuery = (ccy: ReportingCurrency) =>
  queryOptions({
    queryKey: ["allocations", "both"],
    queryFn: ({ signal }) => api<Both<AllocationsDto>>("/api/allocations/both", { signal }),
    select: (d: Both<AllocationsDto>) => d[ccy],
    placeholderData: keepPreviousData,
  });

export function useAllocations(ccy: ReportingCurrency) {
  return useQuery(allocationsQuery(ccy));
}
