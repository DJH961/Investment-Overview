import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import { applyOptimistic, byRoot, rollback, type OptimisticContext } from "./optimistic";

type S = components["schemas"];

/**
 * The currency effect on the portfolio over the whole window since the last
 * acknowledgement, per currency view (server-computed; contract agreed for 7.0,
 * optional until the backend field lands). EUR view: money in euros; USD view: the
 * investing-power equivalent in dollars. `pct` is a fraction; rates are EUR/USD.
 */
export interface BriefCurrencyEffectDto {
  amount: string;
  pct: string;
  rate_then: string;
  rate_now: string;
  since: string;
}

export type BriefDto = S["BriefOut"] & {
  currency_effect_since?: { EUR?: BriefCurrencyEffectDto | null; USD?: BriefCurrencyEffectDto | null } | null;
};
export type BriefMoveDto = S["BriefMove"];
export type BriefFxMoveDto = S["BriefFxMove"];
export type BriefEventDto = S["BriefEvent"];
export type BriefAckDto = S["BriefAckOut"];

export const BRIEF_KEY = ["brief"] as const;

/**
 * The Daily Brief (plan §3.1). Its own endpoint, never inside the overview payload,
 * so a 304 there can never bring a dismissed card back. Both currencies ride in one
 * payload (`move.EUR` / `move.USD`): a currency switch needs no request. Ticks and
 * ledger writes mark it stale with the other reports (see `invalidation.ts`).
 */
export const briefQuery = () =>
  queryOptions({
    queryKey: BRIEF_KEY,
    queryFn: ({ signal }) => api<BriefDto>("/api/brief", { signal }),
  });

export function useBrief() {
  return useQuery(briefQuery());
}

/**
 * Dismiss: POST the acknowledgement with the instant the owner was shown (`now` of
 * the payload on screen), so a boundary that falls while the card was open still
 * brings the next one. Optimistic: the card goes at once and comes back if the
 * write fails. After success the cached Brief stays "not due"; the next read comes
 * from the server, which has moved its marker.
 */
export function useAckBrief() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (seenAt: string | null) =>
      api<BriefAckDto>("/api/brief/ack", { method: "POST", body: { seen_at: seenAt } }),
    onMutate: (): Promise<OptimisticContext> =>
      applyOptimistic(qc, byRoot("brief"), (old) => ({ ...(old as BriefDto), due: false })),
    onError: (_e, _v, ctx) => rollback(qc, ctx),
  });
}
