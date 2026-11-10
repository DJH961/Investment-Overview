/**
 * Per-device "Hide numbers" mode (localStorage `iv.privacy.hideAmounts`, never sent to the server).
 * The flag is pushed into `lib/format.ts` during render so every formatter masks; `RerenderOnHide`
 * (wrapped around each page in `App.tsx`) re-renders the page on a flip, without remounting it, so
 * plain-function formatters re-run while drafts and scroll state survive.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { setHideAmounts } from "./format";
import { usePersistentState } from "./usePersistentState";

export const HIDE_AMOUNTS_KEY = "privacy.hideAmounts";

interface HideCtx {
  hide: boolean;
  setHide: (v: boolean) => void;
  toggle: () => void;
}

const HideContext = createContext<HideCtx | null>(null);

export function HideAmountsProvider({ children }: { children: ReactNode }) {
  const [hide, setHideState] = usePersistentState<boolean>(HIDE_AMOUNTS_KEY, false);
  setHideAmounts(hide); // before children render
  const value = useMemo<HideCtx>(
    () => ({ hide, setHide: setHideState, toggle: () => setHideState((v) => !v) }),
    [hide, setHideState],
  );
  return <HideContext.Provider value={value}>{children}</HideContext.Provider>;
}

export function useHideAmounts(): HideCtx {
  return useContext(HideContext) ?? { hide: false, setHide: () => undefined, toggle: () => undefined };
}

/**
 * Hide-mode chart mapping: every line divided by one shared base (so shapes and
 * the gaps between lines survive) and plotted as a ratio — pair with a percent
 * axis. `base` is the first (or last) usable value of the series `baseId`.
 */
export function relativeSeries<S extends { id: string; points: { t: number | string; v: number | null }[] }>(
  series: S[],
  baseId: string,
  at: "first" | "last" = "first",
): S[] {
  const ref = series.find((s) => s.id === baseId);
  const vals = (ref?.points ?? []).map((p) => p.v).filter((v): v is number => v !== null && v !== 0);
  const base = at === "first" ? vals[0] : vals[vals.length - 1];
  if (base === undefined) return series.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, v: null })) }));
  return series.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, v: p.v === null ? null : p.v / base })) }));
}
