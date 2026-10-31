import { QueryClient, useQuery } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ApiError, api } from "./api";

const DAY = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: DAY,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

export const persister = createSyncStoragePersister({
  storage: typeof window === "undefined" ? undefined : window.localStorage,
  key: "iv.query-cache",
});

export const persistOptions = { persister, maxAge: DAY };

/*
 * Pattern for endpoint hooks (one per endpoint; keys include `ccy` for anything
 * currency dependent so EUR and USD caches never mix):
 *
 *   export function useOverview(ccy: ReportingCurrency) {
 *     return useQuery({
 *       queryKey: ["overview", ccy],
 *       queryFn: ({ signal }) => api<OverviewDto>(`/api/overview?ccy=${ccy}`, { signal }),
 *     });
 *   }
 *
 * TODO(later workers): use DTO types generated into api-types.ts.
 */

export interface AuthMe {
  authenticated: boolean;
  passkeys: number;
}

export function useAuthMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: ({ signal }) => api<AuthMe>("/api/auth/me", { signal, skipAuthRedirect: true }),
    staleTime: 60_000,
  });
}
