import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import { invalidateFor } from "./invalidation";
import { applyOptimistic, byRoot, rollback, type OptimisticContext } from "./optimistic";

type S = components["schemas"];
export type Account = S["AccountOut"];
export type AccountInput = S["AccountIn"];
export type ImportBroker = S["ImportBroker"];

export const ACCOUNT_BROKERS: AccountInput["broker"][] = ["vanguard", "fidelity", "savings_bank"];
export const ACCOUNT_TYPES: NonNullable<AccountInput["account_type"]>[] = ["brokerage", "savings", "cash"];

export const accountsQuery = () =>
  queryOptions({
    queryKey: ["accounts"],
    queryFn: ({ signal }) => api<Account[]>("/api/accounts", { signal }),
  });

export function useAccounts() {
  return useQuery(accountsQuery());
}

export function useImportBrokers() {
  return useQuery({
    queryKey: ["imports", "brokers"],
    queryFn: ({ signal }) => api<ImportBroker[]>("/api/imports/brokers", { signal }),
    staleTime: Infinity,
  });
}

export function useSaveAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: number; body: AccountInput }) =>
      id === undefined
        ? api<Account>("/api/accounts", { method: "POST", body })
        : api<Account>(`/api/accounts/${id}`, { method: "PUT", body }),
    onMutate: ({ id, body }): Promise<OptimisticContext> =>
      applyOptimistic(qc, byRoot("accounts"), (old) => {
        // A new account has no id yet: it appears when the list refetches.
        if (id === undefined || !Array.isArray(old)) return undefined;
        return (old as Account[]).map((a) =>
          a.id === id
            ? { ...a, account_label: body.account_label, broker: body.broker, native_currency: body.native_currency, account_type: body.account_type ?? a.account_type }
            : a,
        );
      }),
    onError: (_e, _v, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateFor(qc, "accountWrite"),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/accounts/${id}`, { method: "DELETE" }),
    onMutate: (id): Promise<OptimisticContext> =>
      applyOptimistic(qc, byRoot("accounts"), (old) =>
        Array.isArray(old) ? (old as Account[]).filter((a) => a.id !== id) : undefined,
      ),
    onError: (_e, _v, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateFor(qc, "accountWrite"),
  });
}
