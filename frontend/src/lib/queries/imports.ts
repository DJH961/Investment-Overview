import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import { useInvalidateAfterWrite, type ImportPreview } from "./ledger";

type Schemas = components["schemas"];
export type ImportBatch = Schemas["ImportBatchOut"];
export type ImportBatchList = Schemas["ImportBatchList"];
export type ImportUndoPreview = Schemas["ImportUndoPreview"];
export type ImportUndoResult = Schemas["ImportUndoResult"];
export type UnknownActionsOut = Schemas["UnknownActionsOut"];
export type ActionOverridesOut = Schemas["ActionOverridesOut"];

export function useImportBatches(limit = 50) {
  return useQuery({
    queryKey: ["import-batches", limit],
    queryFn: ({ signal }) => api<ImportBatchList>(`/api/imports/batches?limit=${limit}`, { signal }),
  });
}

export function useUndoPreview(batchId: number | null) {
  return useQuery({
    queryKey: ["import-undo-preview", batchId],
    queryFn: ({ signal }) => api<ImportUndoPreview>(`/api/imports/batches/${batchId}/undo-preview`, { signal }),
    enabled: batchId !== null,
  });
}

/** Undo deletes ledger rows: refetch everything (history, ledger, graphs). */
export function useUndoBatch() {
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: number; confirm: string }) =>
      api<ImportUndoResult>(`/api/imports/batches/${id}/undo`, { method: "POST", body: { confirm } }),
    onSuccess: invalidate,
  });
}

export function useUnknownActions(importId: string | null) {
  return useQuery({
    queryKey: ["import-unknown-actions", importId],
    queryFn: ({ signal }) =>
      api<UnknownActionsOut>(`/api/imports/unknown-actions?import_id=${encodeURIComponent(importId ?? "")}`, { signal }),
    enabled: importId !== null,
  });
}

export function useSetActionOverride() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ broker, action, kind }: { broker: string; action: string; kind: string | null }) =>
      api<ActionOverridesOut>(`/api/imports/action-overrides/${encodeURIComponent(broker)}`, {
        method: "PUT",
        body: { action, kind },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["import-unknown-actions"] }),
  });
}

/** Parse the staged upload again with the current mapping; returns a new preview (new id). */
export function useReparseImport() {
  return useMutation({
    mutationFn: (importId: string) => api<ImportPreview>(`/api/imports/${importId}/reparse`, { method: "POST" }),
  });
}

export type ImportLayoutIn = Schemas["ImportLayoutIn"];

/** Re-read the staged file with the user's column choices (flexible reader); returns a new preview. */
export function useSetImportLayout() {
  return useMutation({
    mutationFn: ({ importId, body }: { importId: string; body: ImportLayoutIn }) =>
      api<ImportPreview>(`/api/imports/${importId}/layout`, { method: "POST", body }),
  });
}
