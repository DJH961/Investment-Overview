import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ReportingCurrency = "EUR" | "USD";
export type ThemeChoice = "system" | "light" | "dark";

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

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<ReportingCurrency>(() => (read(CCY_KEY) === "USD" ? "USD" : "EUR"));
  const [theme, setThemeState] = useState<ThemeChoice>(() => {
    const v = read(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  });

  useEffect(() => applyTheme(theme), [theme]);

  const setCurrency = useCallback((c: ReportingCurrency) => {
    setCurrencyState(c);
    write(CCY_KEY, c);
  }, []);
  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    write(THEME_KEY, t === "system" ? null : t);
  }, []);
  const cycleTheme = useCallback(() => {
    const order: ThemeChoice[] = ["system", "light", "dark"];
    setTheme(order[(order.indexOf(theme) + 1) % order.length]);
  }, [theme, setTheme]);

  const value = useMemo(
    () => ({ currency, setCurrency, theme, setTheme, cycleTheme }),
    [currency, setCurrency, theme, setTheme, cycleTheme],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return ctx;
}
