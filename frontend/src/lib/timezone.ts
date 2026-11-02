import { useSettings } from "./queries/manage";

/**
 * The user's display timezone from Settings (IANA name), or `undefined` for the
 * browser's own zone until settings have loaded.
 */
export function useTimeZone(): string | undefined {
  const tz = useSettings().data?.timezone;
  return tz || undefined;
}
