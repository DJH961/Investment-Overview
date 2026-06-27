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

/**
 * Severity of a logged line, so the most important events — a genuine failure,
 * a deliberate back-off, a clean success — jump out of the trail instead of
 * hiding in a wall of identical-looking lines. When a caller doesn't set one it
 * is **inferred** at render time from the category and wording (see
 * {@link inferLevel}), so existing call sites keep working unchanged.
 *
 * - `good`  — something settled / succeeded (a fetch landed, the book is live).
 * - `info`  — a neutral, expected step (a decision, a cache hit, a schedule).
 * - `warn`  — we intentionally backed off or degraded (deferred to stay within
 *             budget, skipped a closed market, fell back to the backup) — not an
 *             error, but worth seeing.
 * - `error` — something genuinely failed and was *not* recovered this round.
 */
export type PollLogLevel = "good" | "info" | "warn" | "error";

/** One recorded line of the polling trail. */
export interface PollLogEntry {
  /** Epoch ms the event was recorded. */
  at: number;
  category: PollLogCategory;
  /** A short, plain-language description of what happened. */
  message: string;
  /**
   * Optional explicit severity. When omitted it is inferred at render time, so
   * older persisted entries (and the many neutral call sites) need no level.
   */
  level?: PollLogLevel;
}

/** Options for {@link appendPollLog}. */
export interface AppendPollLogOptions {
  /** Explicit severity for this line; inferred at render time when omitted. */
  level?: PollLogLevel;
  /** Epoch ms to stamp the entry with (defaults to now). */
  at?: number;
  /** Storage to persist into (defaults to localStorage). */
  storage?: StorageLike | null;
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
    return parsed
      .filter(
        (e): e is PollLogEntry =>
          !!e && typeof e === "object" && typeof (e as PollLogEntry).at === "number" && typeof (e as PollLogEntry).message === "string",
      )
      .map((e) => {
        // Drop any persisted `level` that isn't one of the known severities, so a
        // corrupted/old value can never reach the renderer.
        const lvl = (e as PollLogEntry).level;
        return lvl === "good" || lvl === "info" || lvl === "warn" || lvl === "error" ? e : { at: e.at, category: e.category, message: e.message };
      });
  } catch {
    return [];
  }
}

/**
 * Record one event in the polling trail. Trims to {@link MAX_POLL_LOG_ENTRIES}
 * newest entries and persists. Never throws — a logging failure must not break
 * a refresh.
 */
export function appendPollLog(category: PollLogCategory, message: string, opts: AppendPollLogOptions = {}): void {
  const now = opts.at ?? Date.now();
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const entry: PollLogEntry = opts.level ? { at: now, category, message, level: opts.level } : { at: now, category, message };
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

/** Just the local `HH:MM:SS` of a timestamp (used inside a round, where the date
 * is already on the round banner). */
function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => `${n}`.padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A compact human duration for a round span, e.g. `8s`, `1m04s`, `0s`. */
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${`${rem}`.padStart(2, "0")}s`;
}

/** The glyph shown in the gutter for each severity, so failures and back-offs
 * are scannable at a glance. */
const LEVEL_GLYPH: Record<PollLogLevel, string> = {
  good: "✓",
  info: "·",
  warn: "⚠",
  error: "✗",
};

/**
 * Resolve a line's severity: an explicit {@link PollLogEntry.level} always wins;
 * otherwise infer one from the category and wording. The inference is
 * deliberately conservative — it only promotes to `error` on strong failure
 * words that are *not* immediately softened by a recovery clause ("fell back",
 * "left for on-demand", "no new", …), so a handled fallback reads as `warn`, not
 * a scary `error`.
 */
// Wording buckets for {@link inferLevel}, named so the detection rules are easy
// to read, test, and extend without decoding one mega-regex inline.
const RECOVERED_RE =
  /(fell back|left for|left to|left as-is|on-demand|no new|found no|not needed|already|reused|heartbeat)/;
const FAILURE_RE =
  /(fatal|unreachable|rejected|over[- ]?quota|couldn't|could not|can't|\bfailed\b|\bfailure\b|wrong|mismatch|stuck|denied)/;
const BACKOFF_RE =
  /(defer|skip|skipped|backed off|back off|reserve|conserve|stale|degrad|held|offline|fell back|left for|not configured|not needed|over budget)/;
const SETTLED_RE =
  /(fetched|filled|served|all prices live|up to date|downloaded|in line|reused|0 credits|complete|finished|warm)/;
// A "stood-down" line (we *chose* not to pull) earns the distinct ↩ gutter mark.
const STOOD_DOWN_RE =
  /(defer|skip|skipped|reserve|conserve|backed off|back off|held|not needed|over budget|heartbeat)/i;

export function inferLevel(entry: PollLogEntry): PollLogLevel {
  if (entry.level) return entry.level;
  const m = entry.message.toLowerCase();
  if (!RECOVERED_RE.test(m) && FAILURE_RE.test(m)) {
    return "error";
  }
  if (BACKOFF_RE.test(m)) {
    return "warn";
  }
  if (SETTLED_RE.test(m)) {
    return "good";
  }
  return "info";
}

/** A "back-off"/"stood-down" line gets a distinct gutter mark so the user can
 * see exactly where we *chose* not to pull (the user's "did you back down?"). */
function gutterGlyph(entry: PollLogEntry, level: PollLogLevel): string {
  if (level === "warn" && STOOD_DOWN_RE.test(entry.message)) {
    return "↩";
  }
  return LEVEL_GLYPH[level];
}

/**
 * Classify an entry as the *opener* of a new pulling round and return a short
 * "who/what kicked this off" label, or `null` if it isn't a round boundary. The
 * openers are the exact phrases this app emits when a round (or a deliberate
 * no-pull tick) begins, so the trail can be sliced into self-contained rounds.
 */
function roundTrigger(entry: PollLogEntry): string | null {
  const m = entry.message;
  if (entry.category === "refresh") {
    if (m.startsWith("Refresh started")) {
      // "Refresh started: manual (force-all)." → "manual (force-all)"
      const rest = m.slice("Refresh started:".length).replace(/\.\s*$/, "").trim();
      return rest.length > 0 ? rest : "refresh";
    }
    if (m.startsWith("Auto tick skipped")) return "auto tick — skipped (book already up to date)";
    if (m.startsWith("Refresh skipped")) return "refresh — skipped (device offline)";
  }
  if (entry.category === "login") {
    if (m.startsWith("Login warm-up started")) return "login warm-up (pre-fetch)";
    if (m.startsWith("Session resumed")) return "page reload — session resumed";
    if (m.startsWith("Unlock detected")) return "unlock — session start";
  }
  // A Settings "Regenerate 1D/1W graph" is a self-contained pull, not part of the
  // previous refresh round: open its own block so its bar fetch + budget summary
  // are not absorbed into (and hidden behind) the prior round's footer.
  if (entry.category === "note") {
    const regen = m.match(/^Regenerate (1D|1W) graph/);
    if (regen) return `regenerate ${regen[1]} graph (manual)`;
  }
  return null;
}

/** A round: a slice of the trail from one opener up to (not including) the next. */
interface Round {
  trigger: string | null;
  entries: PollLogEntry[];
}

/** Split the flat trail into rounds, keyed on {@link roundTrigger}. Anything
 * before the first opener (a stray note, a version-change line) becomes a
 * leading "session notes" round so nothing is ever dropped. */
function groupRounds(entries: PollLogEntry[]): Round[] {
  const rounds: Round[] = [];
  for (const entry of entries) {
    const trigger = roundTrigger(entry);
    if (trigger !== null || rounds.length === 0) {
      rounds.push({ trigger, entries: [entry] });
    } else {
      rounds[rounds.length - 1].entries.push(entry);
    }
  }
  return rounds;
}

/** Detect the round's closing summary line (the `schedule` "Round complete …"
 * the app emits at the end of a pull), tolerating the older "Refresh finished"
 * wording so previously-saved logs still render their footer. */
function finishEntry(round: Round): PollLogEntry | null {
  for (let i = round.entries.length - 1; i >= 0; i--) {
    const e = round.entries[i];
    if (e.category === "schedule" && /^(Round complete|Refresh finished)/.test(e.message)) return e;
  }
  return null;
}

/** Pull the `N/min · M/day` primary budget out of a finish line, for the macro
 * overview header. Best-effort: returns null when the line doesn't carry it. */
function budgetFromFinish(message: string): string | null {
  const m = message.match(/Budget(?: left| remaining)?\s+([0-9]+\/min[^.;]*?\/day)/i);
  return m ? m[1].trim() : null;
}

/** Pull the secondary `backup X/H this hour · Y/D today` Tiingo budget out of a
 * finish line, for the macro overview header. The 1D/1W graph regeneration spends
 * the scarce Tiingo budget (which never touches the primary `N/min · M/day`
 * read-out), so without surfacing this here the macro total silently undercounts
 * a Tiingo-only regenerate. Best-effort: null when the line carries no backup. */
function tiingoFromFinish(message: string): string | null {
  const m = message.match(/backup\s+([0-9]+\/[0-9]+ this hour[^.;]*?\/[0-9]+ today)/i);
  return m ? m[1].trim() : null;
}

/** Render one round as a clearly bounded block: a header banner naming the
 * trigger and time span, the gutter-marked event lines, and a closing footer
 * summarising the outcome (what settled / failed / backed off / budget left). */
function renderRound(round: Round, index: number): string {
  const first = round.entries[0];
  const last = round.entries[round.entries.length - 1];
  const finish = finishEntry(round);
  // Events shown inside the block: everything except the closing summary, which
  // becomes the footer banner so it reads as the round's verdict, not a step.
  const events = round.entries.filter((e) => e !== finish);

  const triggerLabel = round.trigger ?? "session notes";
  const span =
    first.at === last.at ? clock(first.at) : `${clock(first.at)} → ${clock(last.at)} (${humanDuration(last.at - first.at)})`;
  const dateLabel = stamp(first.at).slice(0, 10);

  const tally = { good: 0, info: 0, warn: 0, error: 0 } as Record<PollLogLevel, number>;
  const errors: string[] = [];
  for (const e of events) {
    const lvl = inferLevel(e);
    tally[lvl] += 1;
    if (lvl === "error") errors.push(e.message);
  }

  const headerBar = `┏━━ ROUND ${index} · ${triggerLabel}`;
  const lines: string[] = [];
  lines.push("");
  lines.push(headerBar);
  lines.push(`┃   ${dateLabel} · ${span}`);
  for (const e of events) {
    const lvl = inferLevel(e);
    lines.push(`┃   ${clock(e.at)}  ${gutterGlyph(e, lvl)}  [${e.category.toUpperCase().padEnd(12)}]  ${e.message}`);
  }
  // Footer verdict: prefer the explicit round-complete summary; otherwise derive
  // a compact tally so even an in-flight / skipped round closes with a verdict.
  let verdict: string;
  let verdictGlyph: string;
  if (finish) {
    verdict = finish.message;
    verdictGlyph = gutterGlyph(finish, inferLevel(finish));
  } else if (round.trigger && /skipped/.test(round.trigger)) {
    verdict = "No pull this round (see above).";
    verdictGlyph = "↩";
  } else {
    const parts = [
      tally.good ? `${tally.good} ok` : null,
      tally.warn ? `${tally.warn} backed off/warn` : null,
      tally.error ? `${tally.error} failed` : null,
    ].filter((p): p is string => p !== null);
    verdict = parts.length ? parts.join(" · ") : "no events";
    verdictGlyph = tally.error ? "✗" : tally.warn ? "↩" : "✓";
  }
  if (errors.length > 0) {
    lines.push(`┃   ⚠ this round had ${errors.length} failure(s):`);
    for (const msg of errors) lines.push(`┃     ✗ ${msg}`);
  }
  lines.push(`┗━━ ${verdictGlyph} ${verdict}`);
  return lines.join("\n");
}

/**
 * Render the polling log as a downloadable plain-text report. The trail is
 * sliced into clearly demarcated **pulling rounds** — each with a header banner
 * (who/what started it, when, how long it took), gutter-marked event lines
 * (✓ ok · ↩ backed off · ⚠ warn · ✗ failed), and a closing verdict (what
 * settled, what failed, what we deferred, and the budget left afterwards). A
 * macro overview at the top counts the rounds and flags how many hit a failure,
 * so a glance answers "did anything go wrong, and where?". Designed to be pasted
 * into a bug report verbatim.
 */
export function formatPollLog(
  entries: PollLogEntry[] = readPollLog(),
  meta: { version?: string; generatedAt?: number } = {},
): string {
  const generatedAt = meta.generatedAt ?? Date.now();
  const rounds = groupRounds(entries);
  // Macro overview: count real pulling rounds (those with a trigger), how many
  // ended in a failure, and the most recent budget we saw — the "big picture".
  const pullingRounds = rounds.filter((r) => r.trigger !== null);
  const failedRounds = rounds.filter((r) => r.entries.some((e) => inferLevel(e) === "error")).length;
  let lastBudget: string | null = null;
  let lastTiingoBudget: string | null = null;
  for (let i = rounds.length - 1; i >= 0 && (lastBudget === null || lastTiingoBudget === null); i--) {
    const f = finishEntry(rounds[i]);
    if (!f) continue;
    if (lastBudget === null) lastBudget = budgetFromFinish(f.message);
    if (lastTiingoBudget === null) lastTiingoBudget = tiingoFromFinish(f.message);
  }
  const header = [
    "Investment Overview — data polling log",
    meta.version ? `App version: ${meta.version}` : null,
    `Generated: ${stamp(generatedAt)}`,
    `Entries: ${entries.length}  ·  Pulling rounds: ${pullingRounds.length}  ·  Rounds with failures: ${failedRounds}`,
    lastBudget ? `Latest budget left: ${lastBudget}` : null,
    lastTiingoBudget ? `Latest backup (Tiingo) budget: ${lastTiingoBudget}` : null,
    "Times are local to this device. Newest rounds are at the bottom.",
    "",
    "Legend:  ✓ settled/ok   ↩ backed off (deferred/skipped to save budget)   ⚠ degraded   ✗ failed   · step",
    "Each round is bounded by ┏━━ (start) and ┗━━ (verdict).",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  if (entries.length === 0) {
    return `${header}\n\n(no polling activity recorded yet)\n`;
  }
  const body = rounds.map((round, i) => renderRound(round, i + 1)).join("\n");
  return `${header}\n${body}\n`;
}
