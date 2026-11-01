import { useMutation, useQuery } from "@tanstack/react-query";
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

export function usePeriods(kind: PeriodKind, ccy: ReportingCurrency) {
  return useQuery({
    queryKey: ["periods", kind, ccy],
    queryFn: ({ signal }) => api<PeriodsOut>(`/api/periods/${kind}?ccy=${ccy}`, { signal }),
  });
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

export function useProjectionMutation(ccy: ReportingCurrency) {
  return useMutation({
    mutationKey: ["calculator", "projection", ccy],
    mutationFn: (body: ProjectionRequest) =>
      api<ProjectionOut>(`/api/calculator?ccy=${ccy}`, { method: "POST", body }),
  });
}
