import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";

export type OverviewDto = components["schemas"]["OverviewResponse"];
export type HoldingsDto = components["schemas"]["HoldingsResponse"];
export type HoldingRowDto = components["schemas"]["HoldingRow"];
export type GraphDto = components["schemas"]["GraphResponse"];
export type AllocationsDto = components["schemas"]["AllocationsResponse"];
export type GraphRange = GraphDto["range"];

export const GRAPH_RANGES: GraphRange[] = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"];

/** Decimal strings from the API to numbers, for display only. */
export function toNum(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function useOverview(ccy: ReportingCurrency) {
  return useQuery({
    queryKey: ["overview", ccy],
    queryFn: ({ signal }) => api<OverviewDto>(`/api/overview?ccy=${ccy}`, { signal }),
  });
}

export function useHoldings(ccy: ReportingCurrency) {
  return useQuery({
    queryKey: ["holdings", ccy],
    queryFn: ({ signal }) => api<HoldingsDto>(`/api/holdings?ccy=${ccy}`, { signal }),
  });
}

export function useGraph(range: GraphRange, ccy: ReportingCurrency, compare: boolean) {
  return useQuery({
    queryKey: ["graphs", range, ccy, compare],
    queryFn: ({ signal }) => api<GraphDto>(`/api/graphs/${range}?ccy=${ccy}&compare=${compare}`, { signal }),
  });
}

export function useAllocations(ccy: ReportingCurrency) {
  return useQuery({
    queryKey: ["allocations", ccy],
    queryFn: ({ signal }) => api<AllocationsDto>(`/api/allocations?ccy=${ccy}`, { signal }),
  });
}
