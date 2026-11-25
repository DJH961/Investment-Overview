import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { applyOptimistic, byRoot, rollback, type OptimisticContext } from "./optimistic";

/**
 * One period of the month / year recap in one reporting currency (7.4 P8). Every figure
 * is the server's: contributed, dividends, interest, the returns and the values are the
 * Periods row of the same label; market and currency the Currency page attribution.
 * TODO: switch to `components["schemas"]["RecapSide"]` once api-types is regenerated.
 */
export interface RecapSideDto {
  contributed: string | null;
  cashed_out: string;
  market: string | null;
  currency: string | null;
  dividends: string | null;
  interest: string | null;
  conversion_cost: string | null;
  conversions: number;
  opening_value: string | null;
  closing_value: string | null;
  nominal_return: string | null;
  real_return: string | null;
  real_to: string | null;
}

export interface RecapDto {
  period: string;
  granularity: "month" | "year";
  start: string;
  end: string;
  is_complete: boolean;
  has_data: boolean;
  due: boolean;
  default_period: string;
  last_ack: string | null;
  EUR: RecapSideDto;
  USD: RecapSideDto;
}

export const RECAP_KEY = ["recap"] as const;

/** `GET /api/recap` (both currencies in one payload: a switch needs no request). */
export const recapQuery = (period?: string | null) =>
  queryOptions({
    queryKey: [...RECAP_KEY, period ?? "default"],
    queryFn: ({ signal }) => api<RecapDto>(`/api/recap${period ? `?period=${encodeURIComponent(period)}` : ""}`, { signal }),
    placeholderData: keepPreviousData,
  });

export function useRecap(period?: string | null) {
  return useQuery(recapQuery(period));
}

/** Dismiss on the Overview: the card goes at once, and comes back if the write fails. */
export function useAckRecap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (period: string) => api<{ last_ack: string }>("/api/recap/ack", { method: "POST", body: { period } }),
    onMutate: (): Promise<OptimisticContext> =>
      applyOptimistic(qc, byRoot("recap"), (old) => (old ? { ...(old as RecapDto), due: false } : old)),
    onError: (_e, _v, ctx) => rollback(qc, ctx),
  });
}
