/** Allocations: current mix, saved targets, drift, saved-target and builder plans. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import { applyOptimistic, byRoot, rollback, type OptimisticContext } from "./optimistic";

type S = components["schemas"];
export type AllocationsData = S["AllocationsResponse"];
export type TargetOut = S["TargetOut"];
export type TargetInput = S["TargetIn"];
export type RebalancePlan = S["RebalanceResponse"];
export type PlanRequest = S["PlanRequest"];
export type BuilderPlan = S["PlanResponse"];
export type BuilderPlanRow = S["BuilderPlanRowOut"];
export type PlanCategory = S["PlanCategoryOut"];

// One hook per key: `["allocations", ccy]` is defined in ./portfolio.
export { useAllocations } from "./portfolio";

export function useSaveTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TargetInput) => api<TargetOut>("/api/allocations", { method: "PUT", body }),
    // Only the target's own fields are drawn early; drift and plans are derived server-side.
    onMutate: (body): Promise<OptimisticContext> =>
      applyOptimistic(qc, byRoot("allocations", "both"), (old) => {
        if (body.id === undefined || body.id === null || !old || typeof old !== "object") return undefined;
        const next = { ...(old as Record<string, AllocationsData>) };
        for (const side of ["EUR", "USD"]) {
          const a = next[side];
          if (!a?.targets) continue;
          next[side] = {
            ...a,
            targets: a.targets.map((t) =>
              t.id === body.id ? { ...t, name: body.name, active: body.active, allow_sell: body.allow_sell } : t,
            ),
          };
        }
        return next;
      }),
    onError: (_e, _v, ctx) => rollback(qc, ctx),
    onSettled: () => qc.invalidateQueries({ queryKey: ["allocations"] }),
  });
}

export interface RebalanceParams {
  amount: string;
  ccy: "EUR" | "USD";
  fractional: boolean;
  allowSell: boolean;
  targetId?: number;
}

export function rebalancePath(p: RebalanceParams): string {
  const q = new URLSearchParams({
    amount: p.amount,
    ccy: p.ccy,
    fractional: String(p.fractional),
    allow_sell: String(p.allowSell),
  });
  if (p.targetId !== undefined) q.set("target_id", String(p.targetId));
  return `/api/allocations/rebalance?${q.toString()}`;
}

/** Plan for a saved target (GET). */
export function useRebalance() {
  return useMutation({
    mutationFn: (p: RebalanceParams) => api<RebalancePlan>(rebalancePath(p)),
  });
}

/** Plan for the builder's unsaved mix, by fund or by category (POST, stores nothing). */
export function useBuilderPlan() {
  return useMutation({
    mutationFn: (body: PlanRequest) => api<BuilderPlan>("/api/allocations/plan", { method: "POST", body }),
  });
}
