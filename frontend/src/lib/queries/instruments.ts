import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import type { components } from "../api-types";
import { useInvalidateAfterWrite } from "./ledger";
import { applyOptimistic, byRoot, rollback, type OptimisticContext } from "./optimistic";

type Schemas = components["schemas"];
export type Instrument = Schemas["InstrumentOut"];
export type InstrumentPatch = Schemas["InstrumentPatch"];
export type InstrumentUpdateResult = Schemas["InstrumentUpdateResult"];
export type PricingMode = Instrument["pricing_mode"];
export type AssetClass = NonNullable<InstrumentPatch["asset_class"]>;

/** The one definition of `["instruments"]` (the Diagnostics pickers use the alias below). */
export const instrumentsQuery = () =>
  queryOptions({
    queryKey: ["instruments"],
    queryFn: ({ signal }) => api<Instrument[]>("/api/instruments", { signal }),
    staleTime: 5 * 60_000,
  });

export function useInstruments() {
  return useQuery(instrumentsQuery());
}

/** Alias kept for the Diagnostics pages; same query as {@link useInstruments}. */
export const useInstrumentList = useInstruments;

/** Names, classes and TERs feed holdings/allocations: refetch just those (see ./invalidation). */
export function useUpdateInstrument() {
  const client = useQueryClient();
  const invalidate = useInvalidateAfterWrite("instrumentEdit");
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: InstrumentPatch }) =>
      api<InstrumentUpdateResult>(`/api/instruments/${id}`, { method: "PATCH", body: patch }),
    onMutate: ({ id, patch }): Promise<OptimisticContext> =>
      applyOptimistic(client, byRoot("instruments"), (old) => {
        if (!Array.isArray(old)) return undefined;
        const edit: Partial<Instrument> = {};
        if (patch.name !== undefined && patch.name !== null) edit.name = patch.name;
        if (patch.category !== undefined) edit.category = patch.category;
        if (patch.active !== undefined && patch.active !== null) edit.active = patch.active;
        if (patch.pricing_mode) edit.pricing_mode = patch.pricing_mode;
        return (old as Instrument[]).map((i) => (i.id === id ? { ...i, ...edit } : i));
      }),
    onError: (_e, _v, ctx) => rollback(client, ctx),
    onSettled: invalidate,
  });
}

/** Start the `prices.redownload` maintenance job for one instrument (browser session only). */
export function useRedownloadPrices() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (instrumentId: number) =>
      api<{ run_id?: string; id?: string }>("/api/maintenance/jobs/prices.redownload", {
        method: "POST",
        body: { params: { instrument_id: instrumentId }, confirm: "yes" },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["maintenance"] }),
  });
}

/** `{field: message}` from the PATCH 422 body (`{detail, errors}`). */
export function instrumentErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return error ? { _form: error instanceof Error ? error.message : "Request failed" } : {};
  const errors = (error.body as { errors?: unknown } | undefined)?.errors;
  if (errors && typeof errors === "object" && !Array.isArray(errors)) {
    return Object.fromEntries(Object.entries(errors as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  }
  return { _form: error.message };
}
