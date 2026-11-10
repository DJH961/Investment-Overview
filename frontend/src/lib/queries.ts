import { QueryClient, useQuery } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { ApiError, addAuthLostListener, api } from "./api";
import { forgetPasskeyDevice } from "./passkeyHint";

const DAY = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: DAY,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Writes fail at once with a clear "can't reach the server" error instead
      // of waiting silently for the network and firing later (a ledger write
      // should never land minutes after the user gave up on it).
      networkMode: "always",
    },
  },
});

export const QUERY_CACHE_KEY = "iv.query-cache";

/**
 * Set while this browser holds a signed-in session (cleared on logout and on
 * any 401). Lets the route guard show the cached app at once on a reload while
 * the network is slow or gone, instead of waiting for the `/auth/me` probe.
 */
export const SIGNED_IN_KEY = "iv.signed-in";

export function hadSignedInSession(): boolean {
  try {
    return window.localStorage.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}

function setSignedInHint(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SIGNED_IN_KEY, "1");
    else window.localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    /* storage unavailable */
  }
}

const storagePersister = createSyncStoragePersister({
  storage: typeof window === "undefined" ? undefined : window.localStorage,
  key: QUERY_CACHE_KEY,
  throttleTime: 0,
});

/** Idle save: if the tab stays open and visible, still write the cache now and then. */
export const PERSIST_IDLE_MS = 60_000;

/**
 * Writing the whole cache to localStorage stringifies megabytes. Live ticks change the cache
 * about once a second, so the save is deferred: it happens when the tab is hidden or closed,
 * or after a quiet minute, never per tick (F-083).
 */
let pendingClient: PersistedClient | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

export function flushPersist(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const client = pendingClient;
  pendingClient = null;
  if (client) void storagePersister.persistClient(client);
}

export const persister: Persister = {
  persistClient: (client) => {
    pendingClient = client;
    idleTimer ??= setTimeout(flushPersist, PERSIST_IDLE_MS);
  },
  restoreClient: () => storagePersister.restoreClient(),
  removeClient: () => {
    pendingClient = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    return storagePersister.removeClient();
  },
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
  window.addEventListener("pagehide", flushPersist);
}

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
  setSignedInHint(false);
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
      // Graph series are the biggest entries and refetch quickly: they stay out of the saved copy.
      query.state.status === "success" && query.queryKey[0] !== "auth" && query.queryKey[0] !== "graphs",
  },
};

// Endpoint hooks live in lib/queries/*. Reports fetch one `/both` entry per report and pick the
// currency with `select`, so EUR and USD never have separate cache entries.

export interface AuthMe {
  authenticated: boolean;
  passkeys: number;
}

/** The "am I signed in?" probe, shared by the route guard and the sign-in flow. */
export const authMeQuery = () => ({
  queryKey: ["auth", "me"] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const me = await api<AuthMe>("/api/auth/me", { signal, skipAuthRedirect: true });
    setSignedInHint(me.authenticated);
    // Signed in with no passkeys registered: nothing to auto-offer at login.
    if (me.authenticated && me.passkeys === 0) forgetPasskeyDevice();
    return me;
  },
  staleTime: 60_000,
});

export function useAuthMe() {
  return useQuery(authMeQuery());
}
