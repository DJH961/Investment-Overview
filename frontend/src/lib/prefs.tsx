import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { DisplayPrefsProvider } from "./displayPrefs";
import { subscribeLiveEvents } from "./live";
import { useAuthMe } from "./queries";
import { SETTINGS_VALUES_KEY, useSettingsValues, type SettingsChanged } from "./queries/settings";

export type ReportingCurrency = "EUR" | "USD";
export type ThemeChoice = "system" | "light" | "dark";

/*
 * Currency and theme: the server setting (`display_currency`, `theme`) is the
 * source of truth across devices. The localStorage copies below are only an
 * instant-paint cache; the server value wins once it has loaded.
 */
const CCY_KEY = "iv.ccy";
const THEME_KEY = "iv.theme";

interface Prefs {
  currency: ReportingCurrency;
  setCurrency: (c: ReportingCurrency) => void;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  cycleTheme: () => void;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* the preference simply will not persist */
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

const themeFromServer = (v: unknown): ThemeChoice | null =>
  v === "auto" ? "system" : v === "light" || v === "dark" ? v : null;
const themeToServer = (t: ThemeChoice) => (t === "system" ? "auto" : t);

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const authed = useAuthMe().data?.authenticated === true;
  const values = useSettingsValues(authed).data;

  const [currency, setCurrencyState] = useState<ReportingCurrency>(() => (read(CCY_KEY) === "USD" ? "USD" : "EUR"));
  const [theme, setThemeState] = useState<ThemeChoice>(() => {
    const v = read(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  });

  useEffect(() => applyTheme(theme), [theme]);

  // Server → local: adopt the server value whenever it changes (another device,
  // the Settings page). Adjusting state during render avoids an effect cascade.
  const serverCcy = values?.display_currency?.value;
  const serverTheme = themeFromServer(values?.theme?.value);
  const [seen, setSeen] = useState<{ ccy: unknown; theme: ThemeChoice | null }>({ ccy: undefined, theme: null });
  if (seen.ccy !== serverCcy || seen.theme !== serverTheme) {
    setSeen({ ccy: serverCcy, theme: serverTheme });
    if ((serverCcy === "EUR" || serverCcy === "USD") && serverCcy !== seen.ccy) setCurrencyState(serverCcy);
    if (serverTheme && serverTheme !== seen.theme) setThemeState(serverTheme);
  }
  useEffect(() => {
    if (serverCcy === "EUR" || serverCcy === "USD") write(CCY_KEY, serverCcy);
  }, [serverCcy]);
  useEffect(() => {
    if (serverTheme) write(THEME_KEY, serverTheme === "system" ? null : serverTheme);
  }, [serverTheme]);

  // Other tabs / devices changed a setting: refetch.
  useEffect(
    () =>
      subscribeLiveEvents((ev) => {
        if (ev.type === "settings") void qc.invalidateQueries({ queryKey: ["settings"] });
      }),
    [qc],
  );

  const authedRef = useRef(authed);
  useEffect(() => {
    authedRef.current = authed;
  }, [authed]);
  const saveToServer = useCallback(
    (changes: Record<string, string>) => {
      if (!authedRef.current) return;
      api<SettingsChanged>("/api/settings/values", { method: "PATCH", body: { changes } })
        .then((r) => qc.setQueryData(SETTINGS_VALUES_KEY, r.values))
        .catch(() => {
          /* keep the local choice; the next load shows the server value again */
        });
    },
    [qc],
  );

  const setCurrency = useCallback(
    (c: ReportingCurrency) => {
      setCurrencyState(c);
      write(CCY_KEY, c);
      saveToServer({ display_currency: c });
    },
    [saveToServer],
  );
  const setTheme = useCallback(
    (t: ThemeChoice) => {
      setThemeState(t);
      write(THEME_KEY, t === "system" ? null : t);
      saveToServer({ theme: themeToServer(t) });
    },
    [saveToServer],
  );
  const cycleTheme = useCallback(() => {
    const order: ThemeChoice[] = ["system", "light", "dark"];
    setTheme(order[(order.indexOf(theme) + 1) % order.length]);
  }, [theme, setTheme]);

  const value = useMemo(
    () => ({ currency, setCurrency, theme, setTheme, cycleTheme }),
    [currency, setCurrency, theme, setTheme, cycleTheme],
  );
  return (
    <PrefsContext.Provider value={value}>
      <DisplayPrefsProvider values={values}>{children}</DisplayPrefsProvider>
    </PrefsContext.Provider>
  );
}

export function usePrefs(): Prefs {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return ctx;
}
