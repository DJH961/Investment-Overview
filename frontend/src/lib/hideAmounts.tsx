/**
 * Per-device "Hide numbers" mode (localStorage `iv.privacy.hideAmounts`, never sent to the server).
 * The flag is pushed into `lib/format.ts` during render so every formatter masks; `AppShell` remounts
 * the page content on a flip so plain-function formatters re-run too.
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
