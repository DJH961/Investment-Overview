import { useDisplayPrefs } from "./displayPrefs";

/**
 * The user's display timezone from Settings (IANA name), or `undefined` for the
 * browser's own zone ("Browser" / "Local", or before settings have loaded).
 */
export function useTimeZone(): string | undefined {
  return useDisplayPrefs().timeZone;
}
