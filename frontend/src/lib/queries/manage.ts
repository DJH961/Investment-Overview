import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import { invalidateFor } from "./invalidation";
import { applyOptimistic, rollback, type OptimisticContext } from "./optimistic";

type S = components["schemas"];
export type FxConversion = S["FxConversionOut"];
export type FxProvider = NonNullable<FxConversion["provider"]>;
export type ConversionUse = S["UsedByOut"];
export type FxConversionInput = S["FxConversionIn"];
export type DepositMatch = S["DepositMatchOut"];
export type DepositStatus = DepositMatch["status"];
export type DepositSlice = S["DepositSliceOut"];
export type RejectedPin = S["RejectedPinOut"];
export type FxPool = S["PoolOut"];
export type FxReference = S["ReferenceOut"];
export type PinInput = S["PinIn"];
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

/** The settled ECB fixing on exactly `date` (no network call); idle until a full date is typed. */
export function useFxReference(date: string) {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  return useQuery({
    queryKey: ["fx-conversions", "reference", date],
    queryFn: ({ signal }) => api<FxReference>(`/api/fx-conversions/reference?date=${date}`, { signal }),
    enabled: valid,
  });
}

export function useSetPins() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ depositId, pins }: { depositId: number; pins: PinInput[] }) =>
      api<DepositMatch>(`/api/fx-conversions/pins/${depositId}`, { method: "PUT", body: { pins } }),
    onSuccess: () => invalidateFor(qc, "fxConversionWrite"),
  });
}

export function useUnpin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (depositId: number) => api<void>(`/api/fx-conversions/pins/${depositId}`, { method: "DELETE" }),
    onSuccess: () => invalidateFor(qc, "fxConversionWrite"),
  });
}

/** Mark / unmark a USD deposit as "received in USD (no conversion)". */
export function useSetReceivedInUsd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ depositId, received }: { depositId: number; received: boolean }) =>
      received
        ? api<unknown>(`/api/fx-conversions/received-in-usd/${depositId}`, { method: "PUT" })
        : api<unknown>(`/api/fx-conversions/received-in-usd/${depositId}`, { method: "DELETE" }),
    onSuccess: () => invalidateFor(qc, "fxConversionWrite"),
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
    onMutate: (body): Promise<OptimisticContext> =>
      applyOptimistic(
        qc,
        (q) => q.queryKey.length === 1 && q.queryKey[0] === "settings",
        (old) => {
          const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
          return { ...(old as SettingsData), ...patch };
        },
      ),
    onError: (_e, _v, ctx) => rollback(qc, ctx),
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
