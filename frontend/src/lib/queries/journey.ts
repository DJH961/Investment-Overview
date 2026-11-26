import { keepPreviousData, queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { CashOutOut, CashOutPreviewIn, JourneyBoth, JourneyView, TrailKind, TrailOut } from "../journey-types";
import type { ReportingCurrency } from "../prefs";

/**
 * The 7.4 currency journey (docs/v7_4_contract_api.md §8): where your dollars are now and
 * where the currency effect came from (`/both`, so a currency switch is a `select`), the
 * money trail behind one transaction, and the cash-out preview. Every figure is the
 * server's; the client only lays them out.
 */

/** The side of a `/both` answer, under either spelling (§8 says `eur`/`usd`, the others `EUR`/`USD`). */
export function journeySide(both: JourneyBoth | undefined, ccy: ReportingCurrency): JourneyView | undefined {
  if (!both) return undefined;
  return ccy === "EUR" ? (both.eur ?? both.EUR) : (both.usd ?? both.USD);
}

export const journeyQuery = () =>
  queryOptions({
    queryKey: ["currency", "journey"],
    queryFn: ({ signal }) => api<JourneyBoth>("/api/currency/journey", { signal }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

export function useJourney(ccy: ReportingCurrency) {
  return useQuery({ ...journeyQuery(), select: (d: JourneyBoth) => journeySide(d, ccy) });
}

export function useTrail(kind: TrailKind | null, id: number | null) {
  return useQuery({
    queryKey: ["trail", kind, id],
    queryFn: ({ signal }) => api<TrailOut>(`/api/trail/${kind}/${id}`, { signal }),
    enabled: kind !== null && id !== null,
    staleTime: 5 * 60_000,
  });
}

/** Works out a conversion back without saving it (the cash-out flow's result card). */
export function useCashOutPreview() {
  return useMutation({
    mutationFn: (body: CashOutPreviewIn) => api<CashOutOut>("/api/cash-out/preview", { method: "POST", body }),
  });
}
