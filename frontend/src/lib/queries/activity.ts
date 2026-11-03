import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";
import type { ReportingCurrency } from "../prefs";

type S = components["schemas"];
export type DepositsDto = S["DepositsOut"];
export type DepositRowDto = S["DepositRowOut"];
export type DividendsDto = S["DividendsOut"];
export type DividendRowDto = S["DividendRowOut"];
export type DepositKindFilter = "deposit" | "withdrawal" | "transfer";

export interface DepositFilters {
  accountId?: number | null;
  kind?: DepositKindFilter | null;
  year?: number | null;
}

/** Contributions ledger; the filters are applied by the server (rows and `by_year`). */
export const depositsQuery = (ccy: ReportingCurrency, filters: DepositFilters = {}) => {
  const params = new URLSearchParams({ ccy });
  if (filters.accountId) params.set("account_id", String(filters.accountId));
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.year) params.set("year", String(filters.year));
  return queryOptions({
    queryKey: ["deposits", ccy, filters.accountId ?? null, filters.kind ?? null, filters.year ?? null],
    queryFn: ({ signal }) => api<DepositsDto>(`/api/deposits?${params}`, { signal }),
    placeholderData: keepPreviousData,
  });
};

export function useDeposits(ccy: ReportingCurrency, filters: DepositFilters = {}) {
  return useQuery(depositsQuery(ccy, filters));
}

/** Dividend and interest income: payments, per year, per holding, TTM and yield. */
export const dividendsQuery = (ccy: ReportingCurrency) =>
  queryOptions({
    queryKey: ["deposits", "dividends", ccy],
    queryFn: ({ signal }) => api<DividendsDto>(`/api/deposits/dividends?ccy=${ccy}`, { signal }),
    placeholderData: keepPreviousData,
  });

export function useDividends(ccy: ReportingCurrency, enabled = true) {
  return useQuery({ ...dividendsQuery(ccy), enabled });
}
