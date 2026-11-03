import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import { invalidateFor } from "./invalidation";

type S = components["schemas"];
export type FxConversion = S["FxConversionOut"];
export type FxConversionInput = S["FxConversionIn"];
export type FxPool = S["PoolOut"];
export type DepositMatch = S["DepositMatchOut"];
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
    // EUR returns are recomputed server-side: only the return-bearing views are stale.
    onSuccess: () => invalidateFor(qc, "fxConversionWrite"),
  });
}

export function useDeleteConversion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/fx-conversions/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateFor(qc, "fxConversionWrite"),
  });
}

// ---- Allocations ----------------------------------------------------------
// Moved to ./allocations; re-exported for existing importers.
export {
  rebalancePath,
  useAllocations,
  useRebalance,
  useSaveTarget,
  type AllocationsData,
  type RebalanceParams,
  type RebalancePlan,
  type TargetInput,
  type TargetOut,
} from "./allocations";

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
