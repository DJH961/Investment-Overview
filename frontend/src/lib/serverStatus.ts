/**
 * What the app knows about the server's availability beyond "the last request
 * failed": a announced restart (deploy), a planned one, or a lost stream.
 * Fed by `live.ts` (SSE `server` events, stream drops, the /api/health poll);
 * read by the banner and by `api()` (GET failures are retried quietly while the
 * server is restarting or lost, so pages keep their data).
 */
import { useSyncExternalStore } from "react";

export type ServerStatus =
  | { kind: "idle" }
  | {
      kind: "restarting";
      /** Version being deployed (the new one), when announced. */
      version: string | null;
      etaS: number | null;
      /** When the announcement arrived (ms since epoch). */
      since: number;
    }
  | { kind: "planned"; at: string | null }
  | { kind: "lost"; since: number }
  /** Back after a restart: shown for a few seconds. */
  | { kind: "updated"; version: string | null };

const IDLE: ServerStatus = { kind: "idle" };
let status: ServerStatus = IDLE;
const listeners = new Set<() => void>();

export function getServerStatus(): ServerStatus {
  return status;
}

export function setServerStatus(next: ServerStatus): void {
  if (status === next) return;
  if (status.kind === "idle" && next.kind === "idle") return;
  status = next;
  listeners.forEach((l) => l());
}

export function resetServerStatus(): void {
  status = IDLE;
  listeners.forEach((l) => l());
}

export function useServerStatus(): ServerStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
    () => IDLE,
  );
}

/** True while failures of GET requests are expected and must stay quiet. */
export function isRidingOutOutage(): boolean {
  return status.kind === "restarting" || status.kind === "lost";
}
