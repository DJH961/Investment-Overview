/** Schema-driven settings (`/api/settings/schema|values|reset|history|export|import`). */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import type { components } from "../api-types";

type S = components["schemas"];
export type SettingField = S["SettingField"];
export type SettingSection = S["SettingSection"];
export type SettingValue = S["SettingValueDto"];
export type SettingJson = SettingValue["value"];
export type SettingsSchema = S["SettingsSchemaDto"];
export type SettingsValues = S["SettingsValuesDto"]["values"];
export type SettingsChanged = S["SettingsChangedDto"];
export type SettingsAuditRow = S["SettingsAuditRow"];
export type SettingsExport = S["SettingsExportDto"];
export type SettingsImportResult = S["SettingsImportResult"];
export type SettingsResetBody = Partial<S["SettingsReset"]>;

export const SETTINGS_VALUES_KEY = ["settings", "values"] as const;
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
export const SETTINGS_EXPORT_URL = `${BASE}/api/settings/export`;

/** The field list changes only with a deploy. */
export const settingsSchemaQuery = () =>
  queryOptions({
    queryKey: ["settings", "schema"],
    queryFn: ({ signal }) => api<SettingsSchema>("/api/settings/schema", { signal }),
    staleTime: 60 * 60 * 1000,
  });

export function useSettingsSchema() {
  return useQuery(settingsSchemaQuery());
}

export const settingsValuesQuery = (enabled = true) =>
  queryOptions({
    queryKey: SETTINGS_VALUES_KEY,
    queryFn: ({ signal }) =>
      api<S["SettingsValuesDto"]>("/api/settings/values", { signal, skipAuthRedirect: !enabled }).then(
        (r) => r.values,
      ),
  });

export function useSettingsValues(enabled = true) {
  return useQuery({ ...settingsValuesQuery(enabled), enabled });
}

function useSettingsWrite<TVars>(fn: (vars: TVars) => Promise<SettingsChanged>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(SETTINGS_VALUES_KEY, data.values);
      // Legacy `/api/settings` readers and the history list.
      return qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "settings" && q.queryKey[1] !== "values" && q.queryKey[1] !== "schema",
      });
    },
  });
}

/** All-or-nothing PATCH; a 422 carries `{errors: {key: message}}` (see `fieldErrors`). */
export function usePatchSettings() {
  return useSettingsWrite((changes: Record<string, SettingJson>) =>
    api<SettingsChanged>("/api/settings/values", { method: "PATCH", body: { changes } }),
  );
}

export function useResetSettings() {
  return useSettingsWrite((body: SettingsResetBody) =>
    api<SettingsChanged>("/api/settings/reset", { method: "POST", body: { all: false, ...body } }),
  );
}

export function useRevertSetting() {
  return useSettingsWrite((auditId: number) =>
    api<SettingsChanged>(`/api/settings/history/${auditId}/revert`, { method: "POST" }),
  );
}

export function useSettingsHistory(key: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["settings", "history", key],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams({ limit: "200" });
      if (key) q.set("key", key);
      return api<S["SettingsHistoryDto"]>(`/api/settings/history?${q.toString()}`, { signal }).then((r) => r.rows);
    },
    enabled,
  });
}

export function exportSettings(): Promise<SettingsExport> {
  return api<SettingsExport>("/api/settings/export");
}

export function useImportSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ payload, dryRun }: { payload: unknown; dryRun: boolean }) =>
      api<SettingsImportResult>(`/api/settings/import?dry_run=${dryRun}`, { method: "POST", body: payload }),
    onSuccess: (_data, vars) => (vars.dryRun ? undefined : qc.invalidateQueries({ queryKey: ["settings"] })),
  });
}

/** Per-key messages from a settings / jobs 422 body, or `{}`. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || e.status !== 422) return {};
  const body = e.body as { errors?: unknown } | undefined;
  if (!body || typeof body.errors !== "object" || body.errors === null) return {};
  return Object.fromEntries(Object.entries(body.errors as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** 403s from guarded writes: a stale session (`reauth_required`) or a token caller (`session_required`). */
export type AuthBlock = "reauth" | "session" | null;

export function authBlock(e: unknown): AuthBlock {
  if (!(e instanceof ApiError) || e.status !== 403) return null;
  const detail = (e.body as { detail?: unknown } | undefined)?.detail;
  const code = detail && typeof detail === "object" ? (detail as { code?: unknown }).code : detail;
  if (code === "reauth_required") return "reauth";
  if (code === "session_required" || typeof code === "string") return "session";
  return "session";
}

/** A readable message for any API error (handles `detail: {code, message}` objects). */
export function errorMessage(e: unknown): string | undefined {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : undefined;
  const detail = (e.body as { detail?: unknown } | undefined)?.detail;
  if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
  const block = authBlock(e);
  if (block === "reauth") return "Please sign in again to continue.";
  if (block === "session") return typeof detail === "string" ? detail : "This action needs a signed-in browser session.";
  return e.message;
}

/** Where to send the user for a fresh sign-in (keeps them on the current page afterwards). */
export function reauthHref(): string {
  const here = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
  return `/login?next=${encodeURIComponent(here)}&reauth=1`;
}
