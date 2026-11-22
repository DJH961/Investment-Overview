import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, readDetail } from "../api";
import type { components } from "../api-types";
import { invalidateFor } from "./invalidation";

type S = components["schemas"];
export type WisePreview = S["WisePreview"];
export type WisePreviewRow = S["WisePreviewRow"];
export type WiseConfirmResult = S["WiseConfirmResult"];
export type WiseRowChoice = S["WiseRowChoiceIn"];

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** Multipart upload of a Wise statement; the answer is the preview (nothing is written yet). */
export async function uploadWiseStatement(file: File): Promise<WisePreview> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/imports/wise`, {
    method: "POST",
    body: form,
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }
  if (res.ok) return payload as WisePreview;
  const { message, code } = readDetail(payload);
  throw new ApiError(res.status, message ?? (res.statusText || `HTTP ${res.status}`), payload, code);
}

export function useUploadWiseStatement() {
  return useMutation({ mutationFn: uploadWiseStatement });
}

/** Map columns by hand when the layout changed; returns a new preview (new id). */
export function useWiseLayout() {
  return useMutation({
    mutationFn: ({ importId, columns }: { importId: string; columns: Record<string, number | null> }) =>
      api<WisePreview>(`/api/imports/wise/${importId}/layout`, { method: "POST", body: { columns } }),
  });
}

export function useConfirmWise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ importId, rows }: { importId: string; rows: WiseRowChoice[] }) =>
      api<WiseConfirmResult>(`/api/imports/wise/${importId}/confirm`, { method: "POST", body: { rows } }),
    onSuccess: () => invalidateFor(qc, "fxConversionWrite"),
  });
}

export function useDiscardWise() {
  return useMutation({
    mutationFn: (importId: string) => api<void>(`/api/imports/wise/${importId}`, { method: "DELETE" }),
  });
}
