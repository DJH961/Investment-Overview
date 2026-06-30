/**
 * Clock **timezone** preference, persisted per device.
 *
 * The desktop app lets the user pin the timezone its header clock renders in
 * (see `timezone_service.py`); this brings the mobile companion to parity. A
 * phone that travels across timezones arguably benefits even more than a desktop
 * does — pin "New York" to keep reading US market times wherever you are.
 *
 * Like the theme and clock-format choices this is a non-secret, device-local
 * preference. The default — `"auto"` — defers to the device's own timezone, so
 * users who never touch the setting keep their familiar local times. Choosing an
 * IANA zone name (e.g. `"America/New_York"`) forces that zone everywhere a clock
 * time is rendered (the "as of" chips, the "last pulled" stamp).
 */

export type TimezoneChoice = "auto" | string;

const STORAGE_KEY = "iv.web.timezone";

/**
 * A short, curated list of zones offered in the Settings picker, on top of the
 * default "auto". Kept deliberately small for a mobile select — it spans the
 * venues a US-holdings / EUR-display owner is most likely to want, plus UTC.
 * Any other valid IANA zone still works if imported via a config packet; the
 * picker just doesn't enumerate the full ~600-zone list on a phone.
 */
export const PRESET_TIMEZONES: readonly string[] = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Amsterdam",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Zurich",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Australia/Sydney",
];

let current: TimezoneChoice = loadTimezone();

/** Whether `value` is a timezone the runtime's `Intl` can actually format in. */
export function isValidTimezone(value: string): boolean {
  if (value === "auto") return true;
  try {
    // Throws a RangeError for an unknown/invalid IANA zone.
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function loadTimezone(): TimezoneChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isValidTimezone(stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode); fall back to auto. */
  }
  return "auto";
}

/** The active timezone preference. */
export function getTimezone(): TimezoneChoice {
  return current;
}

/** Set (and persist) the active timezone preference. Invalid zones are ignored. */
export function setTimezone(value: TimezoneChoice): void {
  if (!isValidTimezone(value)) return;
  current = value;
  try {
    if (value === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* Preference just won't persist; the in-memory choice still applies. */
  }
}

/**
 * The `timeZone` option to merge into `toLocaleTimeString` / `toLocaleString`
 * calls. Returns an empty object for `"auto"` so the device's own zone applies.
 */
export function timeZoneOption(): { timeZone?: string } {
  if (current === "auto") return {};
  return { timeZone: current };
}
