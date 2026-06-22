/**
 * Clock display preference (12-hour AM/PM ↔ 24-hour), persisted per device.
 *
 * Like the theme and display-currency choices, this is a non-secret, device-
 * local preference. The default — `"auto"` — defers to the browser locale, so
 * users who never touch the setting keep their familiar formatting. Choosing
 * `"12h"` or `"24h"` forces that clock everywhere a time is rendered (the
 * "as of" chips, the "last pulled" stamp, the export timestamp).
 */

export type TimeFormat = "auto" | "12h" | "24h";

const STORAGE_KEY = "iv.web.time_format";
const SUPPORTED: TimeFormat[] = ["auto", "12h", "24h"];

let current: TimeFormat = loadTimeFormat();

function isTimeFormat(value: string): value is TimeFormat {
  return (SUPPORTED as string[]).includes(value);
}

function loadTimeFormat(): TimeFormat {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isTimeFormat(stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode); fall back to auto. */
  }
  return "auto";
}

/** The active clock preference. */
export function getTimeFormat(): TimeFormat {
  return current;
}

/** Set (and persist) the active clock preference. */
export function setTimeFormat(value: TimeFormat): void {
  current = value;
  try {
    if (value === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* Preference just won't persist; the in-memory choice still applies. */
  }
}

/**
 * The `hour12` option to merge into `toLocaleTimeString` / `toLocaleString`
 * calls. Returns an empty object for `"auto"` so the locale default applies.
 */
export function clockOptions(): { hour12?: boolean } {
  if (current === "12h") return { hour12: true };
  if (current === "24h") return { hour12: false };
  return {};
}
