import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";

type S = components["schemas"];
export type FxConversion = S["FxConversionOut"];
export type FxConversionInput = S["FxConversionIn"];
export type FxPool = S["PoolOut"];
export type DepositMatch = S["DepositMatchOut"];
export type AllocationsData = S["AllocationsResponse"];
export type TargetOut = S["TargetOut"];
export type TargetInput = S["TargetIn"];
export type RebalancePlan = S["RebalanceResponse"];
export type SettingsData = S["SettingsDto"];
export type SettingsPatch = S["SettingsUpdate"];
export type DiagnosticsData = S["DiagnosticsOut"];
export type RefreshStatusData = S["RefreshStatus"];
export type OnboardingData = S["OnboardingOut"];

/** Plain path for browser downloads (cookie auth, same origin). */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
export const BACKUP_URL = `${BASE}/api/backup`;
export const SUPPORT_BUNDLE_URL = `${BASE}/api/diagnostics/support-bundle`;

// ---- FX conversions -------------------------------------------------------

export function useFxConversions() {
  return useQuery({
    queryKey: ["fx-conversions"],
    queryFn: ({ signal }) => api<FxConversion[]>("/api/fx-conversions", { signal }),
  });
}

export function useFxPool() {
  return useQuery({
    queryKey: ["fx-conversions", "pool"],
    queryFn: ({ signal }) => api<FxPool>("/api/fx-conversions/pool", { signal }),
  });
}

export function useSaveConversion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: number; body: FxConversionInput }) =>
      id === undefined
        ? api<FxConversion>("/api/fx-conversions", { method: "POST", body })
        : api<FxConversion>(`/api/fx-conversions/${id}`, { method: "PUT", body }),
    // EUR returns are recomputed server-side: every currency-dependent view is stale.
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useDeleteConversion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/fx-conversions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ---- Allocations ----------------------------------------------------------

export function useAllocations(ccy: "EUR" | "USD") {
  return useQuery({
    queryKey: ["allocations", ccy],
    queryFn: ({ signal }) => api<AllocationsData>(`/api/allocations?ccy=${ccy}`, { signal }),
  });
}

export function useSaveTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TargetInput) => api<TargetOut>("/api/allocations", { method: "PUT", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allocations"] }),
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

export function useRebalance() {
  return useMutation({
    mutationFn: (p: RebalanceParams) => api<RebalancePlan>(rebalancePath(p)),
  });
}

// ---- Settings -------------------------------------------------------------

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<SettingsData>("/api/settings", { signal }),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPatch) => api<SettingsData>("/api/settings", { method: "PUT", body }),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
}

// ---- Diagnostics / refresh ------------------------------------------------

export function useRefreshStatus(pollMs = 0) {
  return useQuery({
    queryKey: ["refresh", "status"],
    queryFn: ({ signal }) => api<RefreshStatusData>("/api/refresh/status", { signal }),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : pollMs || false),
  });
}

export function useStartRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (force: boolean) => api<RefreshStatusData>(`/api/refresh?force=${force}`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(["refresh", "status"], data);
      return qc.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });
}

export function useDiagnostics() {
  return useQuery({
    queryKey: ["diagnostics"],
    queryFn: ({ signal }) => api<DiagnosticsData>("/api/diagnostics", { signal }),
  });
}

// ---- Onboarding -----------------------------------------------------------

export function useOnboarding() {
  return useQuery({
    queryKey: ["onboarding"],
    queryFn: ({ signal }) => api<OnboardingData>("/api/onboarding", { signal }),
  });
}
