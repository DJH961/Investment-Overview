import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ApiError, api } from "./api";
import type { components } from "./api-types";

type RefreshStatusDto = components["schemas"]["RefreshStatus"];

/** What the app knows about the server's price refresh (fed by SSE, the POST and polling). */
export interface RefreshState {
  running: boolean;
  source: string | null;
  /** A historic download (determinate progress) rather than a quote round. */
  historical: boolean;
  done: number;
  total: number;
  label: string | null;
  /** When new prices last landed (ISO), from `refresh_finished` / `tick`. */
  lastUpdateAt: string | null;
  /** From the latest tick: market open and a price landed within the live window. */
  pricesLive: boolean | null;
}

export const IDLE_REFRESH: RefreshState = {
  running: false,
  source: null,
  historical: false,
  done: 0,
  total: 0,
  label: null,
  lastUpdateAt: null,
  pricesLive: null,
};

let state: RefreshState = IDLE_REFRESH;
const listeners = new Set<() => void>();

export function getRefreshState(): RefreshState {
  return state;
}

export function setRefreshState(patch: Partial<RefreshState>): void {
  const next = { ...state, ...patch };
  if ((Object.keys(next) as (keyof RefreshState)[]).every((k) => next[k] === state[k])) return;
  state = next;
  listeners.forEach((l) => l());
}

/** Test helper: back to idle. */
export function resetRefreshState(): void {
  state = IDLE_REFRESH;
  listeners.forEach((l) => l());
}

export function useRefreshState(): RefreshState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => IDLE_REFRESH,
  );
}

/** Refetch every report query once a refresh finished (auth stays untouched). */
export function invalidateReports(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
}

function fromStatus(s: RefreshStatusDto): Partial<RefreshState> {
  return {
    running: s.running,
    source: s.source ?? null,
    historical: s.historical,
    done: s.progress_done,
    total: s.progress_total,
    label: s.progress_label ?? null,
    ...(s.last_update_at ? { lastUpdateAt: s.last_update_at } : {}),
  };
}

/** Applies one SSE event of the refresh family. Returns true when it was one. */
export function applyRefreshEvent(queryClient: QueryClient, ev: Record<string, unknown>): boolean {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  switch (ev.type) {
    case "refresh_started":
      setRefreshState({ running: true, source: str(ev.source), historical: false, done: 0, total: 0, label: null });
      return true;
    case "refresh_progress":
      setRefreshState({
        running: true,
        historical: ev.historical === true,
        done: num(ev.progress_done),
        total: num(ev.progress_total),
        label: str(ev.progress_label),
      });
      return true;
    case "refresh_finished": {
      const last = str(ev.last_update_at);
      setRefreshState({
        running: false,
        historical: false,
        done: 0,
        total: 0,
        label: null,
        ...(last ? { lastUpdateAt: last } : {}),
      });
      invalidateReports(queryClient);
      return true;
    }
    case "tick": {
      const last = str(ev.last_update_at);
      setRefreshState({
        ...(last ? { lastUpdateAt: last } : {}),
        ...(typeof ev.prices_live === "boolean" ? { pricesLive: ev.prices_live } : {}),
      });
      return false; // ticks also drive the live query invalidation
    }
    default:
      return false;
  }
}

const POLL_MS = 2000;

/**
 * Top-bar refresh: `POST /api/refresh?force=true` (409 = already running, which
 * is fine), then wait for `refresh_finished` over SSE. While running it also polls
 * `/api/refresh/status` every 2 s as a fallback for a dropped stream; on
 * completion every report query is refetched.
 */
export function useServerRefresh(): { start: () => void; state: RefreshState } {
  const queryClient = useQueryClient();
  const current = useRefreshState();

  const start = useCallback(() => {
    if (getRefreshState().running) return;
    setRefreshState({ running: true, source: "manual", historical: false, done: 0, total: 0, label: null });
    // The POST only starts the job; a bounded wait keeps a dead connection from
    // leaving the bar spinning forever.
    api<RefreshStatusDto>("/api/refresh?force=true", { method: "POST", timeoutMs: 30_000 })
      .then((s) => setRefreshState({ ...fromStatus(s), running: true }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 409) return; // already running: keep "Updating…"
        setRefreshState({ running: false });
      });
  }, []);

  useEffect(() => {
    if (!current.running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api<RefreshStatusDto>("/api/refresh/status", { timeoutMs: 5000 })
        .then((s) => {
          if (cancelled || !getRefreshState().running) return;
          setRefreshState(fromStatus(s));
          if (!s.running) invalidateReports(queryClient);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [current.running, queryClient]);

  return { start, state: current };
}
