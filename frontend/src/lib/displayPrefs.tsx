/**
 * Display preferences from the server settings (`/api/settings/values`), with a
 * per-device cache (`iv.displayPrefs`) for an instant first paint.
 *
 * - `lib/format.ts` reads locale / timezone / clock through `setFormatPrefs`.
 * - Pages read their default ranges via `useDisplayPrefs()`.
 * - Currency and theme: the server value is the source of truth across devices;
 *   `lib/prefs.tsx` keeps a local copy only as the instant-paint cache.
 *
 * Later: the per-device "Hide numbers" switch belongs here as a local-only field
 * (usePersistentState, never sent to the server) passed on to `lib/format.ts`.
 */
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setFormatPrefs, type Locale } from "./format";
import type { SettingsValues } from "./queries/settings";
import { readPersisted, writePersisted } from "./usePersistentState";

export type ClockFormat = "auto" | "12h" | "24h";
export type RangeKey = "1d" | "1w" | "1m" | "3m" | "6m" | "ytd" | "1y" | "all";

export interface DisplayPrefs {
  locale: Locale;
  /** The stored setting: "Browser", "Local", "UTC" or an IANA zone. */
  timezone: string;
  /** The zone to format in; `undefined` = the browser's own zone. */
  timeZone: string | undefined;
  clockFormat: ClockFormat;
  /** For `Intl` `hour12`; `undefined` = the locale's default. */
  hour12: boolean | undefined;
  overviewRange: RangeKey;
  holdingsRange: RangeKey;
  /** Risk page lookback in days. */
  riskLookback: number;
  currency: "EUR" | "USD";
  theme: "auto" | "light" | "dark";
}

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  locale: "en-GB",
  timezone: "Local",
  timeZone: undefined,
  clockFormat: "auto",
  hour12: undefined,
  overviewRange: "1m",
  holdingsRange: "1y",
  riskLookback: 365,
  currency: "EUR",
  theme: "auto",
};

const CACHE_KEY = "displayPrefs";
const LOCALES: readonly Locale[] = ["en-GB", "de-DE", "en-US"];
const RANGES: readonly RangeKey[] = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"];

/**
 * "Browser" follows the device. "Local" used to mean the server's zone, which is
 * UTC inside Docker; in the hosted app it means the viewer's device too.
 */
export function resolveTimeZone(setting: string | null | undefined): string | undefined {
  if (!setting || setting === "Browser" || setting === "Local") return undefined;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: setting });
    return setting;
  } catch {
    return undefined;
  }
}

const pick = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

export function prefsFromValues(values: SettingsValues | undefined, base: DisplayPrefs = DEFAULT_DISPLAY_PREFS): DisplayPrefs {
  if (!values) return base;
  const v = (key: string) => values[key]?.value;
  const timezone = typeof v("display_timezone") === "string" ? String(v("display_timezone")) : base.timezone;
  const clockFormat = pick<ClockFormat>(["auto", "12h", "24h"], v("clock_format"), base.clockFormat);
  const lookback = Number(v("chart_pref.analytics_lookback"));
  return {
    locale: pick(LOCALES, v("display.locale"), base.locale),
    timezone,
    timeZone: resolveTimeZone(timezone),
    clockFormat,
    hour12: clockFormat === "12h" ? true : clockFormat === "24h" ? false : undefined,
    overviewRange: pick(RANGES, v("display.overview_default_range"), base.overviewRange),
    holdingsRange: pick(RANGES, v("display.holdings_default_range"), base.holdingsRange),
    riskLookback: Number.isFinite(lookback) && lookback > 0 ? lookback : base.riskLookback,
    currency: pick(["EUR", "USD"] as const, v("display_currency"), base.currency),
    theme: pick(["auto", "light", "dark"] as const, v("theme"), base.theme),
  };
}

const isPrefs = (x: unknown): x is DisplayPrefs =>
  typeof x === "object" && x !== null && LOCALES.includes((x as DisplayPrefs).locale);

export function readCachedPrefs(): DisplayPrefs {
  const cached = readPersisted<DisplayPrefs>(CACHE_KEY, DEFAULT_DISPLAY_PREFS, isPrefs);
  // Re-derive so a cache from an older build never carries stale fields.
  return { ...DEFAULT_DISPLAY_PREFS, ...cached, timeZone: resolveTimeZone(cached.timezone) };
}

let current: DisplayPrefs = DEFAULT_DISPLAY_PREFS;

function apply(prefs: DisplayPrefs): void {
  current = prefs;
  setFormatPrefs({ locale: prefs.locale, timeZone: prefs.timeZone, hour12: prefs.hour12 });
}

// Instant paint: the cached prefs drive formatting before React renders.
if (typeof window !== "undefined") apply(readCachedPrefs());

/** A string that changes whenever formatting output would change. */
export const formatSignature = (p: DisplayPrefs) => `${p.locale}|${p.timeZone ?? ""}|${p.clockFormat}`;

const DisplayPrefsContext = createContext<DisplayPrefs | null>(null);

/**
 * Feeds `useDisplayPrefs()` and `lib/format.ts` from server values (mounted by
 * `PrefsProvider`, which owns the settings query).
 */
export function DisplayPrefsProvider({ values, children }: { values: SettingsValues | undefined; children: ReactNode }) {
  const prefs = useMemo(() => prefsFromValues(values, values ? DEFAULT_DISPLAY_PREFS : readCachedPrefs()), [values]);
  // Format during render so children of this very render already use the new prefs.
  if (prefs !== current) apply(prefs);
  useEffect(() => {
    if (values) writePersisted(CACHE_KEY, prefs);
  }, [prefs, values]);
  return <DisplayPrefsContext.Provider value={prefs}>{children}</DisplayPrefsContext.Provider>;
}

/** Server display prefs (cached per device). Safe outside the provider (falls back to the last applied prefs). */
export function useDisplayPrefs(): DisplayPrefs {
  return useContext(DisplayPrefsContext) ?? current;
}

/**
 * Remounts its children when locale / timezone / clock change, so every
 * plain-function formatter re-renders. Wrap the routes (not the providers:
 * toasts and the router survive). It only fires on a real change.
 */
export function FormatBoundary({ children }: { children: ReactNode }) {
  const sig = formatSignature(useDisplayPrefs());
  const first = useRef(sig);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (sig !== first.current) {
      first.current = sig;
      setGeneration((g) => g + 1);
    }
  }, [sig]);
  return <Fragment key={generation}>{children}</Fragment>;
}
