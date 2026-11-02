import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import type { components } from "../api-types";
import { useInvalidateAfterWrite } from "./ledger";

type Schemas = components["schemas"];
export type Instrument = Schemas["InstrumentOut"];
export type InstrumentPatch = Schemas["InstrumentPatch"];
export type InstrumentUpdateResult = Schemas["InstrumentUpdateResult"];
export type PricingMode = Instrument["pricing_mode"];
export type AssetClass = NonNullable<InstrumentPatch["asset_class"]>;

export function useInstruments() {
  return useQuery({
    queryKey: ["instruments"],
    queryFn: ({ signal }) => api<Instrument[]>("/api/instruments", { signal }),
  });
}

/** Names, classes and TERs feed holdings/allocations: refetch everything after a change. */
export function useUpdateInstrument() {
  const invalidate = useInvalidateAfterWrite();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: InstrumentPatch }) =>
      api<InstrumentUpdateResult>(`/api/instruments/${id}`, { method: "PATCH", body: patch }),
    onSuccess: invalidate,
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
