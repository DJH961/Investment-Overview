import { useEffect, useState } from "react";

/** Subscribe to a CSS media query (breakpoints mirror styles/_mixins.scss). */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && !!window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export const PHONE_QUERY = "(max-width: 639px)";
export const DESKTOP_QUERY = "(min-width: 1024px)";

export const useIsPhone = () => useMediaQuery(PHONE_QUERY);
export const useIsDesktop = () => useMediaQuery(DESKTOP_QUERY);
