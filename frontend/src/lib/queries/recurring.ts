import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import { invalidateFor } from "./invalidation";

type S = components["schemas"];
export type RecurringPlan = S["PlanOut"];
export type RecurringPlanInput = S["PlanIn"];
export type PlanKind = RecurringPlan["kind"];
export type EstimateRow = S["EstimateOut"];
export type Estimates = S["EstimatesOut"];
export type ReminderGroup = S["ReminderGroupOut"];
export type PlanSuggestion = S["SuggestionOut"];
export type SettleBody = S["SettleIn"];
export type SetupPlan = S["SetupPlanOut"];
export type SettleRowBody = S["SettleRowIn"];

export function usePlans() {
  return useQuery({
    queryKey: ["recurring", "plans"],
    queryFn: ({ signal }) => api<RecurringPlan[]>("/api/recurring/plans", { signal }),
  });
}

/** The estimated rows still to settle (the badge number, the grouped reminder, the sheet's drafts). */
export function useEstimates() {
  return useQuery({
    queryKey: ["recurring", "estimates"],
    queryFn: ({ signal }) => api<Estimates>("/api/recurring/estimates", { signal }),
  });
}

/** Plans the recent ledger looks like; only fetched while the setup flow is open. */
export function useSuggestions(enabled: boolean) {
  return useQuery({
    queryKey: ["recurring", "suggestions"],
    queryFn: ({ signal }) => api<PlanSuggestion[]>("/api/recurring/suggestions", { signal }),
    enabled,
  });
}

export function useSavePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: number; body: RecurringPlanInput }) =>
      id === undefined
        ? api<RecurringPlan>("/api/recurring/plans", { method: "POST", body })
        : api<RecurringPlan>(`/api/recurring/plans/${id}`, { method: "PUT", body }),
    onSuccess: () => invalidateFor(qc, "recurringPlanWrite"),
  });
}

export function usePlanAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: "pause" | "resume" | "end" | "delete" }): Promise<unknown> =>
      action === "delete"
        ? api<void>(`/api/recurring/plans/${id}`, { method: "DELETE" })
        : api<RecurringPlan>(`/api/recurring/plans/${id}/${action}`, { method: "POST" }),
    onSuccess: () => invalidateFor(qc, "recurringPlanWrite"),
  });
}

/** Settle estimated rows: typed figures per row, or every row of a due date as estimated. */
export function useSettle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettleBody) => api<S["SettleOut"]>("/api/recurring/settle", { method: "POST", body }),
    onSuccess: () => invalidateFor(qc, "recurringSettle"),
  });
}

/**
 * Defaults that flow between the setup steps, computed on the server: the dollars a
 * conversion yields (step 1) and a dollar total split across an account's holdings (step 3).
 */
export function useSetupPlan(params: {
  eur?: string;
  provider?: string;
  fee?: string;
  total?: string;
  accountId?: number | null;
}) {
  const q = new URLSearchParams();
  if (params.eur) q.set("eur_amount", params.eur);
  if (params.provider) q.set("provider", params.provider);
  if (params.fee) q.set("expected_fee", params.fee);
  if (params.total && params.accountId) {
    q.set("buy_total_usd", params.total);
    q.set("account_id", String(params.accountId));
  }
  const enabled = Boolean(params.eur) || Boolean(params.total && params.accountId);
  return useQuery({
    queryKey: ["recurring", "setup-plan", q.toString()],
    queryFn: ({ signal }) => api<SetupPlan>(`/api/recurring/setup-plan?${q.toString()}`, { signal }),
    enabled,
  });
}
