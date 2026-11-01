import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

export type LiveStatus = "connected" | "reconnecting" | "offline";

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

const TICK_KEYS = ["overview", "holdings", "graphs"];
const STREAM_URL = "/api/stream";

export function handleLiveEvent(queryClient: QueryClient, data: string): void {
  let type: unknown;
  try {
    type = (JSON.parse(data) as { type?: unknown }).type;
  } catch {
    return;
  }
  if (type === "tick" || type === "fx") {
    void queryClient.invalidateQueries({
      predicate: (q) => TICK_KEYS.includes(String(q.queryKey[0])),
    });
  } else if (type === "refresh") {
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  }
}

/** Opens the SSE stream with backoff reconnect; pauses while the tab is hidden. Returns a stop function. */
export function startLive(queryClient: QueryClient): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const close = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    source?.close();
    source = null;
  };

  const connect = () => {
    if (stopped || source || document.hidden) return;
    const es = new EventSource(STREAM_URL);
    source = es;
    es.onopen = () => {
      attempt = 0;
      setStatus("connected");
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
      setStatus("reconnecting");
      connect();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) setStatus("reconnecting");
  connect();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    close();
    setStatus("offline");
  };
}
