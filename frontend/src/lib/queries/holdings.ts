import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";

export type HoldingsDto = components["schemas"]["HoldingsResponse"];
export type HoldingRowDto = components["schemas"]["HoldingRow"];
export type HoldingGroupDto = components["schemas"]["HoldingGroup"];
export type HoldingHistoryDto = components["schemas"]["HoldingHistoryResponse"];
export type HistoryRange = HoldingHistoryDto["range"];
export type HoldingsGroupBy = HoldingsDto["group_by"];

/** `groupBy` makes the server add per-group subtotals (`groups`). */
export function useHoldings(ccy: ReportingCurrency, groupBy: HoldingsGroupBy = "none") {
  return useQuery({
    queryKey: ["holdings", ccy, groupBy],
    queryFn: ({ signal }) => api<HoldingsDto>(`/api/holdings?ccy=${ccy}&group_by=${groupBy}`, { signal }),
  });
}

/** Daily closes of one instrument in its native currency (drawer chart). */
export function useHoldingHistory(instrumentId: number | null, range: HistoryRange) {
  return useQuery({
    queryKey: ["holdings", "history", instrumentId, range],
    enabled: instrumentId !== null,
    queryFn: ({ signal }) =>
      api<HoldingHistoryDto>(`/api/holdings/${instrumentId}/history?range=${range}`, { signal }),
  });
}
