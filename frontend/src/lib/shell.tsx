import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FreshnessStatus } from "../components/Freshness";

/** Lets pages tell the shell their data freshness and how to refresh. */
export interface ShellState {
  freshness: { status: FreshnessStatus; label: string };
  onRefresh?: () => void;
  refreshing: boolean;
}

interface ShellApi extends ShellState {
  setShell: (patch: Partial<ShellState>) => void;
}

const DEFAULT_STATE: ShellState = { freshness: { status: "stale", label: "No data yet" }, refreshing: false };

const ShellContext = createContext<ShellApi | null>(null);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ShellState>(DEFAULT_STATE);
  // Stable identity: pages call setShell from effects, so a new function per
  // render would re-run those effects and loop forever.
  const setShell = useCallback((patch: Partial<ShellState>) => setState((prev) => ({ ...prev, ...patch })), []);
  const api = useMemo<ShellApi>(() => ({ ...state, setShell }), [state, setShell]);
  return <ShellContext.Provider value={api}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellApi {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside <ShellProvider>");
  return ctx;
}

/** Page hook: publish freshness (and optionally a refresh handler) to the top bar. */
export function useShellStatus(status: FreshnessStatus, label: string, onRefresh?: () => void, refreshing = false) {
  const { setShell } = useShell();
  // Keep the latest handler in a ref so inline callbacks don't retrigger the effect.
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  });
  const hasRefresh = onRefresh !== undefined;
  useEffect(() => {
    setShell({
      freshness: { status, label },
      onRefresh: hasRefresh ? () => refreshRef.current?.() : undefined,
      refreshing,
    });
  }, [setShell, status, label, hasRefresh, refreshing]);
}
