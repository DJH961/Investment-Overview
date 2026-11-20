import { useSyncExternalStore } from "react";

/**
 * How many GET reads are in flight, split by who started them: the app itself
 * (live ticks, scheduled refetches: `background`) or the owner (a page load, a click).
 * The top bar uses it to keep background updates quiet (icon + "Updating…" only).
 */
export interface ReadActivity {
  background: number;
  foreground: number;
}

let activity: ReadActivity = { background: 0, foreground: 0 };
const listeners = new Set<() => void>();

function emit(next: ReadActivity): void {
  activity = next;
  listeners.forEach((l) => l());
}

/** A read started; call the returned function once when it settles. */
export function trackRead(background: boolean): () => void {
  const key = background ? "background" : "foreground";
  emit({ ...activity, [key]: activity[key] + 1 });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    emit({ ...activity, [key]: Math.max(0, activity[key] - 1) });
  };
}

export function getReadActivity(): ReadActivity {
  return activity;
}

export function resetReadActivity(): void {
  emit({ background: 0, foreground: 0 });
}

export function useReadActivity(): ReadActivity {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => activity,
    () => activity,
  );
}
