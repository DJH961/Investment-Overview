import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
  const api = useMemo<ShellApi>(
    () => ({ ...state, setShell: (patch) => setState((prev) => ({ ...prev, ...patch })) }),
    [state],
  );
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
  useEffect(() => {
    setShell({ freshness: { status, label }, onRefresh, refreshing });
  }, [setShell, status, label, onRefresh, refreshing]);
}
