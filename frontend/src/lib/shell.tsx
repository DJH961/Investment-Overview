import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FreshnessStatus } from "../components/Freshness";

/** Headline figures a page can pin into the desktop top bar (Overview: value and day move). */
export interface ShellSummary {
  value: number | null;
  currency: string;
  /** Day move as a fraction. */
  pct: number | null;
  move: number | null;
  /** "today" or "Last session · Tue". */
  dayLabel: string;
}

/** Lets pages tell the shell their data freshness and how to refresh. */
export interface ShellState {
  freshness: { status: FreshnessStatus; label: string; short?: string; updated?: string };
  onRefresh?: () => void;
  refreshing: boolean;
  summary?: ShellSummary;
}

interface ShellApi extends ShellState {
  setShell: (patch: Partial<ShellState>) => void;
}

/** No status: pages without live data (Settings, Allocations, Help) show none in the top bar. */
export const DEFAULT_STATE: ShellState = { freshness: { status: "closed", label: "" }, refreshing: false };

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
export function useShellStatus(
  status: FreshnessStatus,
  label: string,
  onRefresh?: () => void,
  refreshing = false,
  short?: string,
  updated?: string,
) {
  const { setShell } = useShell();
  // Keep the latest handler in a ref so inline callbacks don't retrigger the effect.
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  });
  const hasRefresh = onRefresh !== undefined;
  useEffect(() => {
    setShell({
      freshness: { status, label, short, updated },
      onRefresh: hasRefresh ? () => refreshRef.current?.() : undefined,
      refreshing,
    });
  }, [setShell, status, label, short, updated, hasRefresh, refreshing]);
  // Leaving the page: drop its status so the next page does not inherit it.
  useEffect(() => () => setShell(DEFAULT_STATE), [setShell]);
}

/** Page hook: pin headline figures into the desktop top bar (primitives only, so no render loop). */
export function useShellSummary(summary: ShellSummary | undefined) {
  const { setShell } = useShell();
  const { value, currency, pct, move, dayLabel } = summary ?? {};
  const has = summary !== undefined;
  useEffect(() => {
    setShell({
      summary:
        has && currency !== undefined && dayLabel !== undefined
          ? { value: value ?? null, currency, pct: pct ?? null, move: move ?? null, dayLabel }
          : undefined,
    });
  }, [setShell, has, value, currency, pct, move, dayLabel]);
  useEffect(() => () => setShell({ summary: undefined }), [setShell]);
}
