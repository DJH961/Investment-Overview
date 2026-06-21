/**
 * Colour-theme preference (System / Light / Dark), persisted per device.
 *
 * The app still respects the OS `prefers-color-scheme` by default ("system"),
 * but the user can pin a light or dark theme explicitly. The choice is written
 * to `localStorage` and applied via a `data-theme` attribute on the root
 * element, which the stylesheet keys off (see styles.css). Like the rest of the
 * config, this is a non-secret, device-local preference.
 */

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "iv.web.theme";
const ORDER: ThemeChoice[] = ["system", "light", "dark"];

function isThemeChoice(value: string): value is ThemeChoice {
  return (ORDER as string[]).includes(value);
}

/** Read the stored preference, defaulting to "system" when unset/unavailable. */
export function loadTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isThemeChoice(stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode); fall back to system. */
  }
  return "system";
}

function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* Preference just won't persist; the in-memory attribute still applies. */
  }
}

/**
 * Reflect the choice onto the document root. "system" removes the attribute so
 * the `prefers-color-scheme` media queries take over; "light"/"dark" pin it.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

/** Apply the stored preference at boot. */
export function initTheme(): void {
  applyTheme(loadTheme());
}

/** Advance System → Light → Dark → System, persisting and applying the result. */
export function cycleTheme(): ThemeChoice {
  const current = loadTheme();
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  saveTheme(next);
  applyTheme(next);
  return next;
}

/** A short glyph + label for the current choice, for the toggle button. */
export function themeButtonContent(choice: ThemeChoice): { glyph: string; label: string } {
  switch (choice) {
    case "light":
      return { glyph: "☀", label: "Light" };
    case "dark":
      return { glyph: "☾", label: "Dark" };
    default:
      return { glyph: "◐", label: "System" };
  }
}
