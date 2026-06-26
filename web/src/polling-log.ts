/**
 * A persistent, human-readable **data-polling log** for transparency and
 * debugging. The live-data layer is a maze of moving parts — burst-then-slow
 * auto-refresh, a per-minute/day free-tier budget, a cache-first paint, a
 * secondary Tiingo fallback with its own budget and NAV canary, the encrypted
 * blob re-download — and when something looks wrong on screen there has been no
 * way to see *what actually happened*. This module records each meaningful step
 * of every refresh in plain language, persisted across reloads, so the user can
 * download the trail from Settings and see exactly how a number was arrived at:
 * which symbols were served from cache, which were fetched live, which fell to
 * the fallback (and why), what the budgets were, and where the blob stood.
 *
 * It is deliberately best-effort and dependency-free: in private mode (or with
 * storage disabled) it keeps a small in-memory tail so the current session is
 * still downloadable, and it never throws into the refresh hot path.
 */

import type { StorageLike } from "./cache";

const LOG_KEY = "iv.web.polling_log";

/** Cap the persisted log so it can never grow unbounded in localStorage. */
export const MAX_POLL_LOG_ENTRIES = 600;

/** Coarse category for a logged event, so the trail is easy to scan/filter. */
export type PollLogCategory =
  | "login" // unlock detected, session lifecycle
  | "refresh" // a refresh round started/finished (auto/manual/startup/kickoff)
  | "orchestrator" // the single pull orchestrator's per-round leg decision (Pillar 1)
  | "cache" // served from cache / cache decisions
  | "primary" // Twelve Data primary fetch results + budget
  | "fallback" // Tiingo secondary provider activity
  | "fx" // EUR/USD currency pull
  | "graph" // live 1D/1W value-graph backfills (bars/FX) + reuse decisions
  | "blob" // encrypted data-file (blob) checks/downloads
  | "schedule" // next auto-refresh timing
  | "budget" // budget warnings / reserves
  | "note"; // anything else worth recording

/** One recorded line of the polling trail. */
export interface PollLogEntry {
  /** Epoch ms the event was recorded. */
  at: number;
  category: PollLogCategory;
  /** A short, plain-language description of what happened. */
  message: string;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * A tiny in-memory tail kept independently of storage, so the log is still
 * downloadable in private mode (where localStorage writes are dropped) and so a
 * read after a write in the same tick is consistent even if storage is flaky.
 */
let memoryTail: PollLogEntry[] = [];

function readRaw(storage: StorageLike | null): PollLogEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PollLogEntry =>
        !!e && typeof e === "object" && typeof (e as PollLogEntry).at === "number" && typeof (e as PollLogEntry).message === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Record one event in the polling trail. Trims to {@link MAX_POLL_LOG_ENTRIES}
 * newest entries and persists. Never throws — a logging failure must not break
 * a refresh.
 */
export function appendPollLog(
  category: PollLogCategory,
  message: string,
  now: number = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): void {
  const entry: PollLogEntry = { at: now, category, message };
  // Merge the persisted log with the in-memory tail so neither source loses
  // entries, then keep only the newest cap.
  const persisted = readRaw(storage);
  const merged = persisted.length >= memoryTail.length ? persisted : memoryTail;
  const next = [...merged, entry].slice(-MAX_POLL_LOG_ENTRIES);
  memoryTail = next.slice(-Math.min(next.length, 64));
  if (!storage) return;
  try {
    storage.setItem(LOG_KEY, JSON.stringify(next));
  } catch {
    /* storage full/unavailable — the in-memory tail still covers this session. */
  }
}

/** Read the full persisted polling log (oldest first), falling back to memory. */
export function readPollLog(storage: StorageLike | null = defaultStorage()): PollLogEntry[] {
  const persisted = readRaw(storage);
  return persisted.length >= memoryTail.length ? persisted : memoryTail;
}

/** Clear the persisted polling log (and the in-memory tail). */
export function clearPollLog(storage: StorageLike | null = defaultStorage()): void {
  memoryTail = [];
  if (!storage) return;
  try {
    storage.removeItem(LOG_KEY);
  } catch {
    /* best-effort */
  }
}

/** A local `YYYY-MM-DD HH:MM:SS` stamp for a log line. */
function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => `${n}`.padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * Render the polling log as a downloadable plain-text report: a small header
 * plus one timestamped, categorised line per event. Designed to be pasted into
 * a bug report verbatim.
 */
export function formatPollLog(
  entries: PollLogEntry[] = readPollLog(),
  meta: { version?: string; generatedAt?: number } = {},
): string {
  const generatedAt = meta.generatedAt ?? Date.now();
  const header = [
    "Investment Overview — data polling log",
    meta.version ? `App version: ${meta.version}` : null,
    `Generated: ${stamp(generatedAt)}`,
    `Entries: ${entries.length}`,
    "Times are local to this device. Newest entries are at the bottom.",
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  if (entries.length === 0) {
    return `${header}\n(no polling activity recorded yet)\n`;
  }
  // Pad to the widest category label ("orchestrator" = 12) so every line's
  // message starts in the same column — the longest tag must not knock the
  // trail out of alignment.
  const body = entries
    .map((e) => `${stamp(e.at)}  [${e.category.toUpperCase().padEnd(12)}]  ${e.message}`)
    .join("\n");
  return `${header}\n${body}\n`;
}
