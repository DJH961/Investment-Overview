import { keepPreviousData, queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";

type S = components["schemas"];
export type PeriodsOut = S["PeriodsOut"];
export type PeriodRowOut = S["PeriodRowOut"];
export type DepositsOut = S["DepositsOut"];
export type AnalyticsOut = S["AnalyticsOut"];
export type CalculatorInputsOut = S["CalculatorInputsOut"];
export type ProjectionRequest = S["ProjectionRequest"];
export type ProjectionOut = S["ProjectionOut"];

export type PeriodKind = "monthly" | "yearly";

/** API decimals arrive as strings; this is parsing for display, not maths. */
export function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const periodsQuery = (kind: PeriodKind, ccy: ReportingCurrency) =>
  queryOptions({
    queryKey: ["periods", kind, ccy],
    // Monthly asks the server to pad empty months so the history is contiguous.
    queryFn: ({ signal }) =>
      api<PeriodsOut>(`/api/periods/${kind}?ccy=${ccy}${kind === "monthly" ? "&fill_gaps=true" : ""}`, { signal }),
  });

export function usePeriods(kind: PeriodKind, ccy: ReportingCurrency) {
  return useQuery(periodsQuery(kind, ccy));
}

export function useDeposits(ccy: ReportingCurrency) {
  return useQuery({
    queryKey: ["deposits", ccy],
    queryFn: ({ signal }) => api<DepositsOut>(`/api/deposits?ccy=${ccy}`, { signal }),
  });
}

export function useAnalytics(ccy: ReportingCurrency, lookbackDays: number) {
  return useQuery({
    queryKey: ["analytics", ccy, lookbackDays],
    queryFn: ({ signal }) =>
      api<AnalyticsOut>(`/api/analytics?ccy=${ccy}&lookback_days=${lookbackDays}`, { signal }),
  });
}

export function useCalculatorInputs(ccy: ReportingCurrency) {
  return useQuery({
    queryKey: ["calculator", "inputs", ccy],
    queryFn: ({ signal }) => api<CalculatorInputsOut>(`/api/calculator?ccy=${ccy}`, { signal }),
  });
}

/**
 * The projection for `body` (null: not ready, nothing fetched). A query, not a
 * mutation: results are cached per input, a superseded request is aborted, and the
 * previous result stays on screen (`keepPreviousData`) while a new one computes, so
 * the chart never blanks on an input or currency change (docs/v6_speed_plan.md §4.5).
 */
export function useProjection(ccy: ReportingCurrency, body: ProjectionRequest | null) {
  return useQuery({
    queryKey: ["calculator", "projection", ccy, body],
    queryFn: ({ signal }) =>
      api<ProjectionOut>(`/api/calculator?ccy=${ccy}`, { method: "POST", body: body!, signal }),
    enabled: body !== null,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

/** @deprecated Use {@link useProjection}; removed once the Projection page moves over. */
export function useProjectionMutation(ccy: ReportingCurrency) {
  return useMutation({
    mutationKey: ["calculator", "projection", ccy],
    mutationFn: (body: ProjectionRequest) =>
      api<ProjectionOut>(`/api/calculator?ccy=${ccy}`, { method: "POST", body }),
  });
}
