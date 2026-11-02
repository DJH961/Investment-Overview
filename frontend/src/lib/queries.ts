import { QueryClient, useQuery } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ApiError, addAuthLostListener, api } from "./api";

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

export const QUERY_CACHE_KEY = "iv.query-cache";

export const persister = createSyncStoragePersister({
  storage: typeof window === "undefined" ? undefined : window.localStorage,
  key: QUERY_CACHE_KEY,
});

/**
 * Forget every cached server answer: the in-memory query cache, the persisted
 * copy in localStorage and any `iv.*` sessionStorage entries. UI preferences
 * (theme, currency, sidebar) stay. Called on logout and on any 401, so
 * holdings and transactions do not stay readable on a shared or lost device.
 */
export function clearClientData(): void {
  queryClient.clear();
  try {
    void persister.removeClient();
  } catch {
    /* storage unavailable */
  }
  try {
    window.localStorage.removeItem(QUERY_CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
  try {
    const store = window.sessionStorage;
    for (const key of Object.keys(store)) if (key.startsWith("iv.")) store.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

addAuthLostListener(clearClientData);

// Persist report data for instant/offline opens, but never auth state: a
// restored `authenticated: false` would bounce a logged-in user to /login.
export const persistOptions = {
  persister,
  maxAge: DAY,
  dehydrateOptions: {
    shouldDehydrateQuery: (query: { queryKey: readonly unknown[]; state: { status: string } }) =>
      query.state.status === "success" && query.queryKey[0] !== "auth",
  },
};

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
