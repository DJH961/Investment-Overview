import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import type { components } from "../api-types";
import { invalidateFor, type InvalidationKind } from "./invalidation";
import { applyOptimistic, byRoot, rollback, type OptimisticContext } from "./optimistic";

type Schemas = components["schemas"];
export type TransactionOut = Schemas["TransactionOut"];
export type TransactionPage = Schemas["TransactionPage"];
export type TransactionWrite = Schemas["TransactionWrite"];
export type TransactionWriteResult = Schemas["TransactionWriteResult"];
export type TransactionMonth = Schemas["TransactionMonth"];
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
  /** Server-side sort over the whole filtered set. */
  sort?: "date" | "symbol" | "kind" | "account" | "quantity" | "net";
  order?: "asc" | "desc";
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

/** Refetch only what a write changed (the key sets live in ./invalidation). */
export function useInvalidateAfterWrite(kind: InvalidationKind = "transactionWrite") {
  const client = useQueryClient();
  return () => invalidateFor(client, kind);
}

export const transactionsQuery = (filters: TransactionFilters) =>
  queryOptions({
    queryKey: ["transactions", filters],
    queryFn: ({ signal }) => api<TransactionPage>(`/api/transactions?${transactionsQueryString(filters)}`, { signal }),
  });

/** The Transactions page's default first page (prefetched). */
export const DEFAULT_TRANSACTION_FILTERS: TransactionFilters = {
  hide_sweeps: true,
  sort: "date",
  order: "desc",
  limit: 50,
  offset: 0,
};

export function useTransactions(filters: TransactionFilters) {
  return useQuery({ ...transactionsQuery(filters), placeholderData: keepPreviousData });
}

export function useTransaction(id: number | null) {
  return useQuery({
    queryKey: ["transaction", id],
    queryFn: ({ signal }) => api<TransactionOut>(`/api/transactions/${id}`, { signal }),
    enabled: id !== null,
  });
}

/** Edit one row in every cached ledger page and in the single-row cache. */
function patchCachedTransaction(qc: ReturnType<typeof useQueryClient>, id: number, fields: Partial<TransactionOut>) {
  return applyOptimistic(qc, (q) => q.queryKey[0] === "transactions" || q.queryKey[0] === "transaction", (old, key) => {
    if (key[0] === "transaction") {
      return key[1] === id && old && typeof old === "object" ? { ...(old as TransactionOut), ...fields } : undefined;
    }
    const page = old as TransactionPage;
    if (!Array.isArray(page?.rows) || !page.rows.some((r) => r.id === id)) return undefined;
    return { ...page, rows: page.rows.map((r) => (r.id === id ? { ...r, ...fields } : r)) };
  });
}

/**
 * A create has no server id, account name or sort position yet, so it is not drawn
 * early: the list refetches once the write lands (the dialog closes on success).
 */
export function useCreateTransaction() {
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: (body: TransactionWrite) => api<TransactionWriteResult>("/api/transactions", { method: "POST", body }),
    onSuccess: invalidate,
  });
}

/** Fields of the form that map one-to-one onto a ledger row. */
function rowFields(body: TransactionWrite): Partial<TransactionOut> {
  const out: Partial<TransactionOut> = { date: body.date, kind: body.kind, account_id: body.account_id };
  if (body.description !== undefined) out.description = body.description;
  return out;
}

export function useUpdateTransaction() {
  const client = useQueryClient();
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: TransactionWrite }) =>
      api<TransactionWriteResult>(`/api/transactions/${id}`, { method: "PUT", body }),
    onMutate: ({ id, body }): Promise<OptimisticContext> => patchCachedTransaction(client, id, rowFields(body)),
    onError: (_e, _v, ctx) => rollback(client, ctx),
    onSettled: invalidate,
  });
}

export function useDeleteTransaction() {
  const client = useQueryClient();
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/transactions/${id}`, { method: "DELETE" }),
    onMutate: (id): Promise<OptimisticContext> =>
      applyOptimistic(client, byRoot("transactions"), (old) => {
        const page = old as TransactionPage;
        if (!Array.isArray(page?.rows) || !page.rows.some((r) => r.id === id)) return undefined;
        return { ...page, rows: page.rows.filter((r) => r.id !== id), total: Math.max(0, page.total - 1) };
      }),
    onError: (_e, _v, ctx) => rollback(client, ctx),
    onSettled: invalidate,
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
  const invalidate = useInvalidateAfterWrite("importWrite");
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
