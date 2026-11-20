import { QueryClient, useQuery } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { ApiError, addAuthLostListener, api } from "./api";
import { APP_VERSION } from "./appVersion";
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

/** Reading `window.localStorage` itself can throw (blocked storage, some private modes). */
function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

// Without storage the sync persister is a no-op: the app behaves as before the cache existed.
const storagePersister = createSyncStoragePersister({
  storage: safeStorage(),
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
  if (!client) return;
  try {
    void storagePersister.persistClient(client);
  } catch {
    /* quota or blocked storage: the cache is only an optimisation */
  }
}

export const persister: Persister = {
  persistClient: (client) => {
    pendingClient = client;
    idleTimer ??= setTimeout(flushPersist, PERSIST_IDLE_MS);
  },
  restoreClient: async () => {
    try {
      return await storagePersister.restoreClient();
    } catch {
      return undefined;
    }
  },
  removeClient: () => {
    pendingClient = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    return storagePersister.removeClient();
  },
};

if (typeof document !== "undefined") {
  // Back on the tab: an absence of a few minutes starts a new visit server-side (the
  // Daily Brief's window), so ask for the Brief again right now; that read carries the
  // "visible" signal. `pageshow` covers a bfcache restore (iOS Safari), where
  // `visibilitychange` may not fire. Nothing here relies on a "hidden" event: a tab that
  // never says goodbye just stops sending the signal, which counts as "not seen".
  const refetchBriefIfVisible = () => {
    if (document.visibilityState === "visible") void queryClient.invalidateQueries({ queryKey: ["brief"] });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
    refetchBriefIfVisible();
  });
  window.addEventListener("pageshow", refetchBriefIfVisible);
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

/**
 * Only read-only report answers are saved (an allow-list, so a new query never leaks into
 * storage by accident): the Overview, holdings, chart ranges, periods, allocations, the
 * currency page and the brief. Never auth (a restored `authenticated: false` would bounce a
 * signed-in user to /login), settings, accounts, transactions or anything else.
 */
export const PERSISTED_ROOTS: readonly string[] = [
  "overview",
  "holdings",
  "graphs",
  "periods",
  "allocations",
  "currency",
  "brief",
];

/** How long a saved copy may be used (older ones are dropped on restore). */
export const PERSIST_MAX_AGE = DAY;

export function shouldPersistQuery(query: { queryKey: readonly unknown[]; state: { status: string } }): boolean {
  return query.state.status === "success" && PERSISTED_ROOTS.includes(String(query.queryKey[0]));
}

export const persistOptions = {
  persister,
  maxAge: PERSIST_MAX_AGE,
  // A new release drops the old copy (its shapes may differ).
  buster: APP_VERSION,
  dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
};

/**
 * Restored data is a starting picture, not the truth: mark it stale and refetch what is on
 * screen at once. `hydrate` never replaces a query that already holds newer data (a live
 * tick that landed first), so the order is: restore, then live data wins.
 */
export function onCacheRestored(client: QueryClient = queryClient): void {
  void client.invalidateQueries({
    predicate: (q) => q.state.fetchStatus === "idle" && PERSISTED_ROOTS.includes(String(q.queryKey[0])),
  });
}

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
