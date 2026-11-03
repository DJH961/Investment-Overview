/**
 * Connectivity as the app sees it, for the offline banner:
 *
 * - `offline`: the browser says there is no network (`navigator.onLine`).
 * - `unreachable`: the browser thinks it is online, but the last request failed
 *   to reach the server (timeout, dropped connection, or a 502/503/504 from the
 *   proxy while the app restarts). Typical for bad mobile reception.
 * - `online`: the last request got an answer from the app.
 *
 * `api()` reports every outcome here; the browser's online/offline events
 * update it too.
 */
import { useSyncExternalStore } from "react";

export type Connectivity = "online" | "offline" | "unreachable";

function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

let reachable = true;
/** When the server last answered (ms since epoch), for "showing data from …". */
let lastContactAt: number | null = null;
let snapshot: Connectivity = browserOffline() ? "offline" : "online";
const listeners = new Set<() => void>();

function recompute(): void {
  const next: Connectivity = browserOffline() ? "offline" : reachable ? "online" : "unreachable";
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach((l) => l());
}

/** A response came back from the app itself. */
export function markReachable(): void {
  lastContactAt = Date.now();
  reachable = true;
  recompute();
}

/** A request could not reach the app (network error, timeout, proxy 502–504). */
export function markUnreachable(): void {
  reachable = false;
  recompute();
}

export function getConnectivity(): Connectivity {
  return snapshot;
}

export function getLastContactAt(): number | null {
  return lastContactAt;
}

export function useConnectivity(): Connectivity {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => "online" as Connectivity,
  );
}

/** Test helper: back to a clean, online state. */
export function resetConnectivity(): void {
  reachable = true;
  lastContactAt = null;
  snapshot = "online";
  recompute();
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", recompute);
  // Back online: assume the server is reachable until a request says otherwise
  // (TanStack Query refetches on reconnect, which confirms it quickly).
  window.addEventListener("online", () => {
    reachable = true;
    recompute();
  });
}
