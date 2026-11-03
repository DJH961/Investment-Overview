import { useEffect, useState } from "react";

/** Default delay for text filters that reach the server (docs/v6_speed_plan.md G5). */
export const DEBOUNCE_MS = 250;

/** `value`, but only after it has stopped changing for `delayMs` (typing → one request). */
export function useDebouncedValue<T>(value: T, delayMs: number = DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
