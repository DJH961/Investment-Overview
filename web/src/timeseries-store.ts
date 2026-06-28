/**
 * Persistent time-series store for the live-web companion's 1D/1W graphs.
 *
 * Why a new store (docs/v3.0_live_web_companion_proposal.md §10.1/§10.6): the
 * companion is opened far more often than the desktop app is run, so a fresh
 * export blob is usually *not* sitting there. The web build therefore fetches
 * its own intraday/daily history and must **persist** it, keyed by trading day,
 * so a re-open mid-session does **not** re-backfill (smart backfill — never
 * relying on the app having been active). `localStorage` is small and already
 * busy with quotes/FX/credit-log, so the bars live in **IndexedDB**.
 *
 * The storage backend is dependency-injected (same pattern as `secret-store`):
 * the default is IndexedDB-backed, but tests inject {@link memoryBackend} so they
 * need no browser. Decimals are (de)serialised as strings so values survive a
 * structured-clone round-trip without precision loss.
 */

import { Decimal } from "./decimal-config";
import type { Bar, CurvePoint } from "./timeseries";
import { summarizeClear, type ClearSummary } from "./data-registry";

/** A bar serialised for storage: `[epochMs, decimalString]`. */
type StoredBar = [number, string];

/**
 * A breadcrumb serialised for storage. The 3-tuple `[epochMs, eurString,
 * usdString]` is the legacy whole-book form; the 5-tuple additionally carries the
 * base (settled cash + NAV funds) the total was struck against — `[…, baseEur,
 * baseUsd]` — so a later build can rebase the trail onto the current base.
 */
type StoredTip =
  | [number, string, string]
  | [number, string, string, string, string];

/**
 * A live-tip **breadcrumb**: the whole-book headline total at instant `t`,
 * optionally tagged with the constant base (settled cash + NAV funds) it was
 * struck against. Recording the base lets a later build **rebase** the persisted
 * trail onto the *current* base, so an intraday NAV strike or FX move shifts the
 * whole curve uniformly instead of leaving a step where stale crumbs meet fresh
 * bars. Crumbs written before the base was recorded simply omit it and render
 * unrebased (their whole-book total as-is).
 */
export interface Breadcrumb extends CurvePoint {
  /** Constant EUR base the whole-book `valueEur` was struck against (omit ⇒ no rebase). */
  baseEur?: Decimal;
  /** Constant USD base the whole-book `valueUsd` was struck against (omit ⇒ no rebase). */
  baseUsd?: Decimal;
}

/**
 * A per-symbol, per-day **close-completeness probe** — the decision layer's
 * memory of how far an after-close price track has progressed and whether it has
 * been **settled** (the best close anyone can give us, terminal for the day).
 *
 * Plain numbers/booleans only, so it (de)serialises straight through a
 * structured-clone round-trip with no Decimal handling. Keyed by symbol inside
 * {@link StoredSession.closeProbe}; the per-day session key naturally resets it
 * next trading session (docs/session_close_completeness_plan.md C1/P3).
 */
export interface StoredCloseProbe {
  /** Session-relative ms of the newest bar we have seen for this symbol. */
  lastBarAt: number;
  /** Post-close fetch attempts this day. */
  attempts: number;
  /** Distinct providers that returned this same tip (0 ⇒ outage). */
  sources: 0 | 1 | 2;
  /**
   * How many times both providers have independently agreed on the same pre-close
   * tip (the two-step confirmation counter). Absent/0 until the first agreement;
   * the close is accepted once it reaches `AGREEMENTS_TO_SETTLE`. A progression or
   * outage between agreements drops the field, resetting the count.
   */
  agreements?: number;
  /** Terminal: the best-available close has been accepted — never re-fetch today. */
  settled: boolean;
  /** Wall-clock ms of the last probe (the C4 spacing gate reads this). */
  lastAttemptAt: number;
}

/** A session's worth of bars, persisted under its trading-day key. */
export interface StoredSession {
  /** Trading day this session covers, `YYYY-MM-DD` (the primary key). */
  day: string;
  /** Per-symbol native price bars (oldest first). */
  bars: Record<string, Bar[]>;
  /** EUR→USD bars for the session (oldest first); empty when none fetched. */
  fx: Bar[];
  /**
   * Live-tip **breadcrumbs** (oldest first): the whole-book headline totals the
   * curve was last drawn at, dropped as the live tip moved. They cost nothing to
   * record — each is a value the dashboard already computed — and let the 1D
   * curve self-thicken between the slow, credit-conscious bar re-fetches instead
   * of showing a single lone moving dot. Real bars are ground truth, so a build
   * keeps a build's breadcrumbs only when they fall *after* its freshest bar (see
   * `mergeBreadcrumbs`). Optional/absent on records written before breadcrumbs
   * existed (treated as an empty trail). Each crumb may carry the base it was
   * struck against ({@link Breadcrumb}) so the trail can be rebased on render.
   */
  tips?: Breadcrumb[];
  /**
   * Per-symbol close-completeness probes (the after-close settle memory). Absent
   * on records written before probes existed (treated as "no probe yet"); the
   * per-day session key resets it next session. See {@link StoredCloseProbe} and
   * docs/session_close_completeness_plan.md (C1).
   */
  closeProbe?: Record<string, StoredCloseProbe>;
  /** Epoch ms the session's *bars* were last fetched — for the refetch throttle. */
  updatedAt: number;
}

/** The on-disk record shape (Decimals as strings). */
interface SerializedSession {
  day: string;
  bars: Record<string, StoredBar[]>;
  fx: StoredBar[];
  tips?: StoredTip[];
  /** Plain-number probe map (no Decimals); round-trips as-is. */
  closeProbe?: Record<string, StoredCloseProbe>;
  updatedAt: number;
}

/**
 * Minimal async key→value backend. A real browser uses IndexedDB; tests inject
 * an in-memory map. Keys are trading-day strings; values are
 * {@link SerializedSession} records.
 */
export interface TimeSeriesBackend {
  get(key: string): Promise<SerializedSession | undefined>;
  put(key: string, value: SerializedSession): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const DB_NAME = "investment-overview-timeseries";
const STORE_NAME = "sessions";
const DB_VERSION = 1;

/** A genuine `YYYY-MM-DD` session key — distinguishes dated sessions from namespaced caches. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function serializeBars(bars: Bar[]): StoredBar[] {
  return bars.map((b) => [b.t, b.value.toString()]);
}

function deserializeBars(stored: StoredBar[] | undefined): Bar[] {
  if (!Array.isArray(stored)) return [];
  return stored.map(([t, value]) => ({ t, value: new Decimal(value) }));
}

function serializeTips(tips: Breadcrumb[]): StoredTip[] {
  return tips.map((t) =>
    t.baseEur !== undefined && t.baseUsd !== undefined
      ? [
          t.t,
          t.valueEur.toString(),
          t.valueUsd.toString(),
          t.baseEur.toString(),
          t.baseUsd.toString(),
        ]
      : [t.t, t.valueEur.toString(), t.valueUsd.toString()],
  );
}

function deserializeTips(stored: StoredTip[] | undefined): Breadcrumb[] {
  if (!Array.isArray(stored)) return [];
  return stored.map((entry) => {
    const crumb: Breadcrumb = {
      t: entry[0],
      valueEur: new Decimal(entry[1]),
      valueUsd: new Decimal(entry[2]),
    };
    if (entry.length === 5) {
      crumb.baseEur = new Decimal(entry[3]);
      crumb.baseUsd = new Decimal(entry[4]);
    }
    return crumb;
  });
}

function serialize(session: StoredSession): SerializedSession {
  const bars: Record<string, StoredBar[]> = {};
  for (const [symbol, list] of Object.entries(session.bars)) {
    bars[symbol] = serializeBars(list);
  }
  const record: SerializedSession = {
    day: session.day,
    bars,
    fx: serializeBars(session.fx),
    tips: serializeTips(session.tips ?? []),
    updatedAt: session.updatedAt,
  };
  if (session.closeProbe && Object.keys(session.closeProbe).length > 0) {
    record.closeProbe = session.closeProbe;
  }
  return record;
}

/**
 * Validate one stored close-probe entry, tolerating legacy/garbage shapes — a
 * malformed entry is dropped rather than throwing, so a partial or pre-probe
 * payload still deserialises (schema back-compat, plan C1 failure modes).
 */
function deserializeCloseProbe(
  raw: Record<string, unknown> | undefined,
): Record<string, StoredCloseProbe> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, StoredCloseProbe> = {};
  for (const [symbol, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (
      typeof v.lastBarAt !== "number" ||
      typeof v.attempts !== "number" ||
      typeof v.sources !== "number" ||
      typeof v.settled !== "boolean" ||
      typeof v.lastAttemptAt !== "number"
    ) {
      continue;
    }
    const sources = v.sources === 2 ? 2 : v.sources === 1 ? 1 : 0;
    out[symbol] = {
      lastBarAt: v.lastBarAt,
      attempts: v.attempts,
      sources,
      settled: v.settled,
      lastAttemptAt: v.lastAttemptAt,
      ...(typeof v.agreements === "number" ? { agreements: v.agreements } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function deserialize(record: SerializedSession): StoredSession {
  const bars: Record<string, Bar[]> = {};
  for (const [symbol, list] of Object.entries(record.bars ?? {})) {
    bars[symbol] = deserializeBars(list);
  }
  return {
    day: record.day,
    bars,
    fx: deserializeBars(record.fx),
    tips: deserializeTips(record.tips),
    closeProbe: deserializeCloseProbe(
      record.closeProbe as Record<string, unknown> | undefined,
    ),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

/** A simple in-memory backend for tests (and any environment without IndexedDB). */
export function memoryBackend(): TimeSeriesBackend {
  const map = new Map<string, SerializedSession>();
  return {
    get: (key) => Promise.resolve(map.get(key)),
    put: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...map.keys()]),
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "day" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function reqResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** The default IndexedDB-backed backend. Throws if IndexedDB is unavailable. */
export function indexedDbBackend(): TimeSeriesBackend {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  return {
    async get(key) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const value = await reqResult(tx.objectStore(STORE_NAME).get(key));
        return (value as SerializedSession | undefined) ?? undefined;
      } finally {
        db.close();
      }
    },
    async put(_key, value) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(value);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async keys() {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const keys = await reqResult(tx.objectStore(STORE_NAME).getAllKeys());
        return (keys as IDBValidKey[]).map((k) => String(k));
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Default minimum spacing between persisted live-tip breadcrumbs (1 minute).
 *
 * A build can happen on every chart re-render or burst refresh, far more often
 * than the curve visibly moves, so breadcrumbs are decimated to roughly one a
 * minute — dense enough to draw a smooth trail across a long watch, sparse enough
 * that a whole trading session stays well within {@link DEFAULT_MAX_TIPS}.
 */
export const DEFAULT_TIP_SPACING_MS = 60_000;

/**
 * Hard cap on stored breadcrumbs per session (most-recent kept). A regular US
 * session is 6.5h ≈ 390 minutes, so 600 leaves comfortable headroom at the
 * default 1-minute spacing while bounding the IndexedDB record.
 */
export const DEFAULT_MAX_TIPS = 600;

/**
 * The time-series store. Reads/writes whole sessions keyed by trading day and
 * prunes anything outside the retained window, so a week of 1D curves rolls up
 * into 1W (§10.6) without the store growing without bound.
 */
export class TimeSeriesStore {
  private readonly backend: TimeSeriesBackend;

  constructor(backend: TimeSeriesBackend = indexedDbBackend()) {
    this.backend = backend;
  }

  /** Load a session by trading day, or `null` if none stored. */
  async loadSession(day: string): Promise<StoredSession | null> {
    const record = await this.backend.get(day);
    return record ? deserialize(record) : null;
  }

  /** Persist a session, replacing any existing record for the same day. */
  async saveSession(session: StoredSession): Promise<void> {
    await this.backend.put(session.day, serialize(session));
  }

  /**
   * Merge new bars into a day's stored session (de-duplicating by instant) and
   * persist. Lets a mid-session refresh append the live tip / fill gaps without
   * re-fetching the whole day — the heart of smart, incremental backfill.
   */
  async mergeSession(
    day: string,
    incoming: {
      bars?: Record<string, Bar[]>;
      fx?: Bar[];
      /** New/updated per-symbol close probes (merged field-by-field; settled sticky). */
      closeProbe?: Record<string, StoredCloseProbe>;
      /** Symbols whose probe should be dropped (e.g. a symbol that reached the close). */
      closeProbeClear?: string[];
    },
    now: number = Date.now(),
  ): Promise<StoredSession> {
    const existing =
      (await this.loadSession(day)) ?? { day, bars: {}, fx: [], tips: [], updatedAt: 0 };
    const bars: Record<string, Bar[]> = { ...existing.bars };
    for (const [symbol, list] of Object.entries(incoming.bars ?? {})) {
      bars[symbol] = mergeBars(existing.bars[symbol] ?? [], list);
    }
    const fx = incoming.fx ? mergeBars(existing.fx, incoming.fx) : existing.fx;
    // Merge the close probes per symbol: a new record wins field-by-field, but a
    // `settled:true` is **sticky** for the day (it survives a later same-bar
    // probe). A `{bars}`/`{fx}`-only merge carries no probe and must therefore
    // **preserve** the existing trail exactly like `tips` — so this starts from a
    // copy of what is already stored (plan C1).
    const closeProbe = mergeCloseProbes(
      existing.closeProbe,
      incoming.closeProbe,
      incoming.closeProbeClear,
    );
    // Preserve any breadcrumbs already recorded for the day — a bar fetch must
    // never wipe the live-tip trail.
    const merged: StoredSession = { day, bars, fx, tips: existing.tips ?? [], updatedAt: now };
    if (closeProbe) merged.closeProbe = closeProbe;
    await this.saveSession(merged);
    return merged;
  }

  /**
   * Record one live-tip **breadcrumb** for a day and return the (bounded) trail.
   *
   * Each breadcrumb is a whole-book headline total the dashboard already computed,
   * so persisting it costs no API credits; the trail lets the 1D curve build
   * itself out between the slow bar re-fetches. Writes are decimated to at most
   * one per {@link DEFAULT_TIP_SPACING_MS} (a tip closer than that to the last
   * one *replaces* it, so the latest position still advances without unbounded
   * growth) and capped at {@link DEFAULT_MAX_TIPS} most-recent points. Crucially
   * this does **not** bump `updatedAt`, so it never fools the bar-refetch throttle
   * into thinking fresh bars were fetched.
   */
  async appendTip(
    day: string,
    tip: Breadcrumb,
    options: { spacingMs?: number; maxTips?: number } = {},
  ): Promise<Breadcrumb[]> {
    const spacing = options.spacingMs ?? DEFAULT_TIP_SPACING_MS;
    const maxTips = options.maxTips ?? DEFAULT_MAX_TIPS;
    const existing =
      (await this.loadSession(day)) ?? { day, bars: {}, fx: [], tips: [], updatedAt: 0 };
    const tips = [...(existing.tips ?? [])];
    const last = tips[tips.length - 1];
    if (last && tip.t <= last.t) {
      // Out-of-order or same instant — replace the tail so the latest wins.
      tips[tips.length - 1] = tip;
    } else if (last && tip.t - last.t < spacing) {
      // Too soon since the last breadcrumb — replace it rather than crowd the
      // trail, keeping the most recent position without unbounded growth.
      tips[tips.length - 1] = tip;
    } else {
      tips.push(tip);
    }
    const bounded = tips.length > maxTips ? tips.slice(tips.length - maxTips) : tips;
    const merged: StoredSession = {
      day,
      bars: existing.bars,
      fx: existing.fx,
      tips: bounded,
      // Leave `updatedAt` untouched: breadcrumbs are not a bar fetch.
      updatedAt: existing.updatedAt,
    };
    // A breadcrumb write must never wipe the close-probe memory either.
    if (existing.closeProbe) merged.closeProbe = existing.closeProbe;
    await this.saveSession(merged);
    return bounded;
  }

  /** All stored trading days, ascending. */
  async listDays(): Promise<string[]> {
    return (await this.backend.keys()).sort();
  }

  /**
   * Drop a **single** stored record by key — a dated session (`YYYY-MM-DD`) or a
   * namespaced cache (e.g. the {@link WEEK_STORE_KEY} 1W daily-close sleeve). This
   * is the scoped counterpart to {@link clear}: the Settings "Regenerate 1D / 1W
   * graph" buttons wipe just that one curve's bars/tips so the forced re-pull
   * rebuilds it from scratch, leaving every other day untouched. A no-op when the
   * key is absent.
   */
  async deleteSession(key: string): Promise<void> {
    await this.backend.delete(key);
  }

  /**
   * Drop every stored day **strictly before** `oldestDay` (`YYYY-MM-DD`). Days
   * compare correctly as plain strings, so a single lexical compare keeps the
   * rolling 1W window and discards the rest. Only genuine `YYYY-MM-DD` session
   * keys are considered: namespaced keys (e.g. the 1W daily-close cache) sort
   * before real dates but must never be swept away by a session prune, so they
   * are skipped.
   */
  async prune(oldestDay: string): Promise<void> {
    for (const day of await this.backend.keys()) {
      if (DATE_KEY_RE.test(day) && day < oldestDay) await this.backend.delete(day);
    }
  }

  /**
   * Drop **every** stored record — dated sessions *and* namespaced caches (e.g.
   * the 1W daily-close sleeve). This is the intraday counterpart to clearing the
   * price caches: the live 1D/1W graphs are rebuilt from the bars/tips persisted
   * here, so a "reset cache" that left this store intact would leave a stale or
   * malformed 1D/1W curve on screen even after the wipe. Clearing it forces the
   * next refresh to rebuild those curves from scratch.
   *
   * The wipe consults the **core-vs-bonus data registry** ({@link summarizeClear})
   * so its intent is explicit rather than implicit: every key it touches is a
   * `core` series with a guaranteed reload path (1D/1W bars, long-range value
   * history) — losing them is safe by contract — or a `bonus` trail that may be
   * lost. An `onSummary` reporter receives that classification (the app logs it),
   * and an `unregistered` key is surfaced there so a *new, unclassified* store
   * cannot slip through a hard reset unnoticed.
   */
  async clear(options: { onSummary?: (summary: ClearSummary) => void } = {}): Promise<void> {
    const keys = await this.backend.keys();
    if (options.onSummary) options.onSummary(summarizeClear(keys));
    for (const key of keys) {
      await this.backend.delete(key);
    }
  }
}

/**
 * Merge two bar lists into one ascending, instant-deduplicated list. A later
 * write for the same instant wins (incoming overrides existing), so a corrected
 * bar replaces a provisional one.
 */
function mergeBars(existing: Bar[], incoming: Bar[]): Bar[] {
  const byTime = new Map<number, Decimal>();
  for (const bar of existing) byTime.set(bar.t, bar.value);
  for (const bar of incoming) byTime.set(bar.t, bar.value);
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, value]) => ({ t, value }));
}

/**
 * Merge two per-symbol close-probe maps. The `incoming` record wins field by
 * field, except `settled` is **sticky** — once a symbol is settled for the day it
 * stays settled even if a later same-bar probe carries `settled:false` (plan
 * C1/P3). `clear` drops a symbol's probe entirely (e.g. it reached the close).
 * Returns `undefined` when the merged map is empty so an absent probe field
 * round-trips as `undefined` rather than an empty object.
 */
function mergeCloseProbes(
  existing: Record<string, StoredCloseProbe> | undefined,
  incoming: Record<string, StoredCloseProbe> | undefined,
  clear: string[] | undefined,
): Record<string, StoredCloseProbe> | undefined {
  if (!existing && !incoming && (!clear || clear.length === 0)) return undefined;
  const out: Record<string, StoredCloseProbe> = { ...(existing ?? {}) };
  for (const [symbol, next] of Object.entries(incoming ?? {})) {
    const prev = out[symbol];
    out[symbol] = { ...next, settled: (prev?.settled ?? false) || next.settled };
  }
  for (const symbol of clear ?? []) delete out[symbol];
  return Object.keys(out).length > 0 ? out : undefined;
}
