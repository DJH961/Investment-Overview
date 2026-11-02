import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/** Every key this hook writes is namespaced under this prefix. */
export const STORAGE_PREFIX = "iv.";

/** Returns true when a parsed value has the shape the caller expects. */
export type Validator<T> = (value: unknown) => value is T;

/**
 * Default shape check: same `typeof` as the default value, arrays stay arrays
 * and objects stay non-null objects. Pass a custom validator for anything stricter
 * (unions of string literals, objects with required fields, ...).
 */
export function sameShape<T>(fallback: T): Validator<T> {
  return (value: unknown): value is T => {
    if (Array.isArray(fallback)) return Array.isArray(value);
    if (fallback === null) return value === null;
    if (typeof fallback === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
    return typeof value === typeof fallback;
  };
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // access itself can throw (blocked site data, sandboxed frames)
  }
}

/** Reads `iv.<key>`; returns `fallback` on a miss, bad JSON, wrong shape or a throwing storage. */
export function readPersisted<T>(key: string, fallback: T, validate: Validator<T> = sameShape(fallback)): T {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Writes `iv.<key>`; silently does nothing when storage is unavailable or full. */
export function writePersisted<T>(key: string, value: T): void {
  try {
    storage()?.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota exceeded / private mode: keep the in-memory value only */
  }
}

/**
 * `useState` that remembers its value per device in localStorage under
 * `iv.<key>`. A `null` key disables persistence (plain `useState`). Stored values
 * that fail `validate` are ignored, so a renamed option never breaks a page.
 */
export function usePersistentState<T>(
  key: string | null,
  fallback: T,
  validate?: Validator<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (key === null ? fallback : readPersisted(key, fallback, validate)));

  // fallback/validate are read through refs so callers may pass inline values.
  const fallbackRef = useRef(fallback);
  const validateRef = useRef(validate);
  useEffect(() => {
    fallbackRef.current = fallback;
    validateRef.current = validate;
  });

  // Follow changes made in another tab.
  useEffect(() => {
    if (key === null || typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_PREFIX + key) setValue(readPersisted(key, fallbackRef.current, validateRef.current));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (key !== null) writePersisted(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}
