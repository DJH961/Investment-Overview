import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { markStaleAndRefetch, scheduleRefetchAllActive } from "./queries/invalidation";
import { api } from "./api";
import { applyTick, patchGraphPoint, patchOverviewFromEvent, type TickLike, type TickPointDto } from "./tickPatch";
import type { components } from "./api-types";
import { applyRefreshEvent } from "./refresh";
import { getServerStatus, setServerStatus } from "./serverStatus";
import { noteServerVersion } from "./appVersion";

/** `connecting`: first attempt (or back from a hidden tab); `reconnecting`: after an error. */
export type LiveStatus = "connecting" | "connected" | "reconnecting" | "offline";

let status: LiveStatus = "offline";
const listeners = new Set<() => void>();

function setStatus(next: LiveStatus) {
  if (status === next) return;
  status = next;
  listeners.forEach((l) => l());
}

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
    () => "offline" as LiveStatus,
  );
}

export function getLiveStatus(): LiveStatus {
  return status;
}

const STREAM_URL = "/api/stream";
const HEALTH_URL = "/api/health";
const HEALTH_POLL_MS = 2000;
/** A dropped stream shows "connection lost" only after this long (no flash on brief blips). */
export const LOST_AFTER_MS = 5000;
/** "Updated to x" stays this long. */
export const UPDATED_SHOWN_MS = 4000;

/** A parsed SSE message (`type` discriminates; see `api/schemas/stream.py`). */
export type LiveEvent = Record<string, unknown> & { type: string };

const eventListeners = new Set<(ev: LiveEvent) => void>();

/** Listen to every SSE event (components waiting for e.g. a `graphs` reload). Returns unsubscribe. */
export function subscribeLiveEvents(cb: (ev: LiveEvent) => void): () => void {
  eventListeners.add(cb);
  return () => {
    eventListeners.delete(cb);
  };
}

export { patchOverviewFromEvent };

/** Highest tick sequence number seen (the catch-up after a reconnect asks for newer ones). */
let lastSeq: number | null = null;

/** Test helper. */
export function resetLiveSeq(): void {
  lastSeq = null;
}

function noteSeq(ev: Record<string, unknown>): void {
  if (typeof ev.seq === "number" && (lastSeq === null || ev.seq > lastSeq)) lastSeq = ev.seq;
}

/**
 * After a gap (tab back, network back) ask the server what was missed and apply it
 * without refetching. Returns false when it could not (caller falls back to a refetch).
 */
export async function catchUpLive(queryClient: QueryClient): Promise<boolean> {
  if (lastSeq === null) return false;
  try {
    const res = await api<components["schemas"]["LiveResponse"]>(`/api/live?since=${lastSeq}`, { rideOut: false });
    for (const p of res.missed_points ?? []) patchGraphPoint(queryClient, p as TickPointDto);
    if (res.tick) applyTick(queryClient, res.tick as TickLike);
    if (typeof res.seq === "number" && (lastSeq === null || res.seq > lastSeq)) lastSeq = res.seq;
    return true;
  } catch {
    return false;
  }
}

// ---- server restarts / lost stream --------------------------------------------

/** Set by `startLive` so the restart flow can reopen the stream. */
let reconnectStream: (() => void) | null = null;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let updatedTimer: ReturnType<typeof setTimeout> | undefined;
let lostTimer: ReturnType<typeof setTimeout> | undefined;

function stopHealthPoll(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = undefined;
}

/** Test helper: forget timers and the stream hook between tests. */
export function resetServerFlow(): void {
  stopHealthPoll();
  if (updatedTimer) clearTimeout(updatedTimer);
  if (lostTimer) clearTimeout(lostTimer);
  updatedTimer = undefined;
  lostTimer = undefined;
  reconnectStream = null;
}

/** The running app version, or null while the server does not answer. */
async function readHealthVersion(): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctl.signal, credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { app_version?: unknown };
    return typeof body.app_version === "string" ? body.app_version : "";
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** The server is back: reconnect the stream, refetch once (staggered), show "Updated" for a moment. */
function finishRestart(queryClient: QueryClient, version: string | null): void {
  stopHealthPoll();
  reconnectStream?.();
  scheduleRefetchAllActive(queryClient);
  setServerStatus({ kind: "updated", version });
  if (import.meta.env.PROD) noteServerVersion(version);
  if (updatedTimer) clearTimeout(updatedTimer);
  updatedTimer = setTimeout(() => {
    if (getServerStatus().kind === "updated") setServerStatus({ kind: "idle" });
  }, UPDATED_SHOWN_MS);
}

function startHealthPoll(queryClient: QueryClient, announced: string | null, etaS: number | null): void {
  stopHealthPoll();
  const began = Date.now();
  let baseline: string | null = null;
  let sawGap = false;
  let busy = false;
  healthTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    void readHealthVersion()
      .then((version) => {
        if (getServerStatus().kind !== "restarting") {
          stopHealthPoll();
          return;
        }
        if (version === null) {
          sawGap = true;
          return;
        }
        baseline ??= version;
        const overdue = Date.now() - began > Math.max(30_000, (etaS ?? 0) * 3000);
        if (sawGap || version !== baseline || overdue) finishRestart(queryClient, announced ?? version);
      })
      .finally(() => {
        busy = false;
      });
  }, HEALTH_POLL_MS);
}

function handleServerEvent(queryClient: QueryClient, ev: LiveEvent): void {
  if (ev.state === "restarting") {
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = undefined;
    const version = typeof ev.version === "string" ? ev.version : null;
    const etaS = typeof ev.eta_s === "number" ? ev.eta_s : null;
    setServerStatus({ kind: "restarting", version, etaS, since: Date.now() });
    startHealthPoll(queryClient, version, etaS);
  } else if (ev.state === "restart_planned") {
    if (getServerStatus().kind === "restarting") return;
    setServerStatus({ kind: "planned", at: typeof ev.at === "string" ? ev.at : null });
  }
}

export function handleLiveEvent(queryClient: QueryClient, data: string): void {
  let ev: LiveEvent;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") return;
    ev = parsed as LiveEvent;
  } catch {
    return;
  }
  const type = ev.type;
  applyRefreshEvent(queryClient, ev);
  if (type === "tick" || type === "fx") {
    // Totals and the rate go on screen now; one staggered refetch of the active
    // tick-dependent queries follows. Inactive ones are only marked stale.
    noteSeq(ev);
    applyTick(queryClient, ev as TickLike);
    markStaleAndRefetch(queryClient, "tick");
  } else if (type === "refresh") {
    markStaleAndRefetch(queryClient, "refresh");
  } else if (type === "graphs" && typeof ev.range === "string") {
    void queryClient.invalidateQueries({ queryKey: ["graphs", ev.range] });
  } else if (type === "server") {
    handleServerEvent(queryClient, ev);
  }
  eventListeners.forEach((l) => l(ev));
}

/** Opens the SSE stream with backoff reconnect; pauses while the tab is hidden. Returns a stop function. */
export function startLive(queryClient: QueryClient): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;
  // After the first successful open, every later open means we may have missed ticks.
  let openedBefore = false;

  const close = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    source?.close();
    source = null;
  };

  const connect = () => {
    if (stopped || source || document.hidden) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setStatus("offline"); // the `online` listener reconnects
      return;
    }
    const es = new EventSource(STREAM_URL);
    source = es;
    es.onopen = () => {
      attempt = 0;
      setStatus("connected");
      if (lostTimer) clearTimeout(lostTimer);
      lostTimer = undefined;
      if (getServerStatus().kind === "lost") setServerStatus({ kind: "idle" });
      // A tab opened before a deploy still runs the old build: reload it quietly.
      if (import.meta.env.PROD) void readHealthVersion().then(noteServerVersion);
      if (openedBefore) {
        void catchUpLive(queryClient).then((ok) => {
          if (!ok) markStaleAndRefetch(queryClient, "tick");
        });
      }
      openedBefore = true;
    };
    es.onmessage = (ev: MessageEvent<string>) => handleLiveEvent(queryClient, ev.data);
    es.onerror = () => {
      close();
      if (stopped || document.hidden) return;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      setStatus(offline ? "offline" : "reconnecting");
      // A drop with no announced restart: say "lost" only if it lasts (no flash on blips).
      if (!offline && !lostTimer && getServerStatus().kind === "idle") {
        lostTimer = setTimeout(() => {
          lostTimer = undefined;
          if (getServerStatus().kind === "idle" && getLiveStatus() !== "connected") {
            setServerStatus({ kind: "lost", since: Date.now() });
          }
        }, LOST_AFTER_MS);
      }
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      timer = setTimeout(connect, delay);
    };
  };

  const onVisibility = () => {
    if (document.hidden) {
      close();
      setStatus("offline");
    } else {
      attempt = 0;
      setStatus("connecting");
      connect();
    }
  };
  // Network back: reconnect now instead of waiting out a backoff of up to 30 s.
  const onOnline = () => {
    if (document.hidden) return;
    close();
    attempt = 0;
    setStatus("connecting");
    connect();
  };
  // Network gone: stop retrying until the browser reports it back.
  const onOffline = () => {
    close();
    setStatus("offline");
  };
  reconnectStream = () => {
    close();
    attempt = 0;
    connect();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  if (!document.hidden) setStatus("connecting");
  connect();

  return () => {
    stopped = true;
    reconnectStream = null;
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = undefined;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    close();
    setStatus("offline");
  };
}
