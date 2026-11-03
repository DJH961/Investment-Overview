import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { applyRefreshEvent } from "./refresh";

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

const TICK_KEYS = ["overview", "holdings", "graphs"];
const STREAM_URL = "/api/stream";

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

function invalidateTickKeys(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (q) => TICK_KEYS.includes(String(q.queryKey[0])),
  });
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
    invalidateTickKeys(queryClient);
  } else if (type === "refresh") {
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  } else if (type === "graphs" && typeof ev.range === "string") {
    void queryClient.invalidateQueries({ queryKey: ["graphs", ev.range] });
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
      if (openedBefore) invalidateTickKeys(queryClient);
      openedBefore = true;
    };
    es.onmessage = (ev: MessageEvent<string>) => handleLiveEvent(queryClient, ev.data);
    es.onerror = () => {
      close();
      if (stopped || document.hidden) return;
      setStatus(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "reconnecting");
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
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  if (!document.hidden) setStatus("connecting");
  connect();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    close();
    setStatus("offline");
  };
}
