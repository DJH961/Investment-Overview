import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { subscribeLiveEvents } from "../../lib/live";
import type { GraphRange } from "../../lib/queries/portfolio";

/** Give up waiting for the `graphs` SSE event after this long (the query still refetches on it). */
const WAIT_MS = 120_000;

export interface GraphReloadResult {
  range: string;
  ok: boolean;
  points: number | null;
}

/**
 * Per-graph reload: `POST /api/graphs/{range}/reload` (202 started / 409
 * already running), then wait for the `graphs` SSE event for that range.
 * `lib/live.ts` already invalidates the graph query when it arrives.
 */
export function useGraphReload(onDone: (r: GraphReloadResult) => void, onError: (message: string) => void) {
  const [busy, setBusy] = useState<GraphRange | null>(null);
  const doneRef = useRef(onDone);
  const errorRef = useRef(onError);
  useEffect(() => {
    doneRef.current = onDone;
    errorRef.current = onError;
  });

  useEffect(() => {
    if (busy === null) return;
    const off = subscribeLiveEvents((ev) => {
      if (ev.type !== "graphs" || ev.range !== busy) return;
      setBusy(null);
      doneRef.current({ range: busy, ok: ev.ok !== false, points: typeof ev.points === "number" ? ev.points : null });
    });
    const timer = setTimeout(() => setBusy(null), WAIT_MS);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [busy]);

  const reload = useCallback((range: GraphRange) => {
    setBusy(range);
    api(`/api/graphs/${range}/reload`, { method: "POST" }).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) return; // already running: keep waiting
      setBusy(null);
      errorRef.current(err instanceof Error ? err.message : "Reload failed");
    });
  }, []);

  return { reload, busy };
}
