import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import type { components } from "../api-types";

type Schemas = components["schemas"];
export type TransactionOut = Schemas["TransactionOut"];
export type TransactionPage = Schemas["TransactionPage"];
export type TransactionWrite = Schemas["TransactionWrite"];
export type TransactionWriteResult = Schemas["TransactionWriteResult"];
export type ImportPreview = Schemas["ImportPreview"];
export type ImportConfirmResult = Schemas["ImportConfirmResult"];

export interface TransactionFilters {
  account_id?: number;
  symbol?: string;
  kind?: string;
  start?: string;
  end?: string;
  q?: string;
  hide_sweeps?: boolean;
  limit: number;
  offset: number;
}

export function transactionsQueryString(filters: TransactionFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === "" || value === null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/** Refetch everything except the auth probe after a ledger write. */
export function useInvalidateAfterWrite() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
}

export function useTransactions(filters: TransactionFilters) {
  return useQuery({
    queryKey: ["transactions", filters],
    queryFn: ({ signal }) => api<TransactionPage>(`/api/transactions?${transactionsQueryString(filters)}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useTransaction(id: number | null) {
  return useQuery({
    queryKey: ["transaction", id],
    queryFn: ({ signal }) => api<TransactionOut>(`/api/transactions/${id}`, { signal }),
    enabled: id !== null,
  });
}

export function useCreateTransaction() {
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: (body: TransactionWrite) => api<TransactionWriteResult>("/api/transactions", { method: "POST", body }),
    onSuccess: invalidate,
  });
}

export function useUpdateTransaction() {
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: TransactionWrite }) =>
      api<TransactionWriteResult>(`/api/transactions/${id}`, { method: "PUT", body }),
    onSuccess: invalidate,
  });
}

export function useDeleteTransaction() {
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/transactions/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/** Map a FastAPI 422 body to `{ field: message }`; unknown locations land under `_form`. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return { _form: error instanceof Error ? error.message : "Request failed" };
  const detail = (error.body as { detail?: unknown } | undefined)?.detail;
  if (!Array.isArray(detail)) return { _form: error.message };
  const out: Record<string, string> = {};
  for (const item of detail as Array<{ loc?: unknown[]; msg?: string }>) {
    const field = item.loc && item.loc.length > 1 ? String(item.loc[item.loc.length - 1]) : "_form";
    out[field] = item.msg ?? "Invalid value";
  }
  return out;
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface UploadArgs {
  file: File;
  accountId?: number;
  broker?: string;
  onProgress?: (fraction: number) => void;
}

/** Multipart upload via XHR so progress can be reported. */
export function uploadImport({ file, accountId, broker, onProgress }: UploadArgs): Promise<ImportPreview> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    if (accountId !== undefined) form.append("account_id", String(accountId));
    if (broker) form.append("broker", broker);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/imports`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error while uploading"));
    xhr.onload = () => {
      let payload: unknown;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as ImportPreview);
        return;
      }
      const detail = (payload as { detail?: unknown } | undefined)?.detail;
      reject(new ApiError(xhr.status, typeof detail === "string" ? detail : xhr.statusText || `HTTP ${xhr.status}`, payload));
    };
    xhr.send(form);
  });
}

export function useUploadImport() {
  return useMutation({ mutationFn: uploadImport });
}

export function useConfirmImport() {
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: (importId: string) => api<ImportConfirmResult>(`/api/imports/${importId}/confirm`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useDiscardImport() {
  return useMutation({
    mutationFn: (importId: string) => api<void>(`/api/imports/${importId}`, { method: "DELETE" }),
  });
}
