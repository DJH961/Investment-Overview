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

type Both<T> = { EUR: T; USD: T };
export type PeriodKind = "monthly" | "yearly";

/** API decimals arrive as strings; this is parsing for display, not maths. */
export function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const periodsQuery = (kind: PeriodKind, ccy: ReportingCurrency) =>
  queryOptions({
    queryKey: ["periods", kind, "both"],
    // Monthly asks the server to pad empty months so the history is contiguous.
    queryFn: ({ signal }) =>
      api<Both<PeriodsOut>>(`/api/periods/${kind}/both${kind === "monthly" ? "?fill_gaps=true" : ""}`, { signal }),
    select: (d: Both<PeriodsOut>) => d[ccy],
    placeholderData: keepPreviousData,
  });

export function usePeriods(kind: PeriodKind, ccy: ReportingCurrency) {
  return useQuery(periodsQuery(kind, ccy));
}

// One hook per key: `useDeposits` lives in ./activity (it takes the filters).
export { useDeposits } from "./activity";

export const analyticsQuery = (ccy: ReportingCurrency, lookbackDays: number) =>
  queryOptions({
    queryKey: ["analytics", "both", lookbackDays],
    queryFn: ({ signal }) => api<Both<AnalyticsOut>>(`/api/analytics/both?lookback_days=${lookbackDays}`, { signal }),
    select: (d: Both<AnalyticsOut>) => d[ccy],
    // A lookback or currency change keeps the old figures until the new ones land.
    placeholderData: keepPreviousData,
  });

/** The Risk page's default lookback (days) when nothing is remembered. */
export const DEFAULT_LOOKBACK_DAYS = 365;

export function useAnalytics(ccy: ReportingCurrency, lookbackDays: number) {
  return useQuery(analyticsQuery(ccy, lookbackDays));
}

export const calculatorInputsQuery = (ccy: ReportingCurrency) =>
  queryOptions({
    queryKey: ["calculator", "inputs", "both"],
    queryFn: ({ signal }) => api<Both<CalculatorInputsOut>>("/api/calculator/both", { signal }),
    select: (d: Both<CalculatorInputsOut>) => d[ccy],
    placeholderData: keepPreviousData,
  });

export function useCalculatorInputs(ccy: ReportingCurrency) {
  return useQuery(calculatorInputsQuery(ccy));
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
