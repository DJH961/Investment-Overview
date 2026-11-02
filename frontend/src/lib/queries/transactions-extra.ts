import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";

export type ReconcileRequest = components["schemas"]["ReconcileRequest"];
export type ReconcileResult = components["schemas"]["ReconcileResult"];

/** Quantity x price = total check (fills the missing figure or reports a mismatch). */
export function reconcileTrade(body: ReconcileRequest, signal?: AbortSignal): Promise<ReconcileResult> {
  return api<ReconcileResult>("/api/transactions/reconcile", { method: "POST", body, signal });
}

export function useReconcileTrade() {
  return useMutation({ mutationFn: (body: ReconcileRequest) => reconcileTrade(body) });
}
