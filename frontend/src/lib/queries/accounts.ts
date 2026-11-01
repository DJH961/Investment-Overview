import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";

type S = components["schemas"];
export type Account = S["AccountOut"];
export type AccountInput = S["AccountIn"];
export type ImportBroker = S["ImportBroker"];

export const ACCOUNT_BROKERS: AccountInput["broker"][] = ["vanguard", "fidelity", "savings_bank"];
export const ACCOUNT_TYPES: NonNullable<AccountInput["account_type"]>[] = ["brokerage", "savings", "cash"];

export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: ({ signal }) => api<Account[]>("/api/accounts", { signal }),
  });
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
}
