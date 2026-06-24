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

/** A bar serialised for storage: `[epochMs, decimalString]`. */
type StoredBar = [number, string];

/** A breadcrumb serialised for storage: `[epochMs, eurString, usdString]`. */
type StoredTip = [number, string, string];

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
   * existed (treated as an empty trail).
   */
  tips?: CurvePoint[];
  /** Epoch ms the session's *bars* were last fetched — for the refetch throttle. */
  updatedAt: number;
}

/** The on-disk record shape (Decimals as strings). */
interface SerializedSession {
  day: string;
  bars: Record<string, StoredBar[]>;
  fx: StoredBar[];
  tips?: StoredTip[];
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

function serializeTips(tips: CurvePoint[]): StoredTip[] {
  return tips.map((t) => [t.t, t.valueEur.toString(), t.valueUsd.toString()]);
}

function deserializeTips(stored: StoredTip[] | undefined): CurvePoint[] {
  if (!Array.isArray(stored)) return [];
  return stored.map(([t, eur, usd]) => ({
    t,
    valueEur: new Decimal(eur),
    valueUsd: new Decimal(usd),
  }));
}

function serialize(session: StoredSession): SerializedSession {
  const bars: Record<string, StoredBar[]> = {};
  for (const [symbol, list] of Object.entries(session.bars)) {
    bars[symbol] = serializeBars(list);
  }
  return {
    day: session.day,
    bars,
    fx: serializeBars(session.fx),
    tips: serializeTips(session.tips ?? []),
    updatedAt: session.updatedAt,
  };
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
    incoming: { bars?: Record<string, Bar[]>; fx?: Bar[] },
    now: number = Date.now(),
  ): Promise<StoredSession> {
    const existing =
      (await this.loadSession(day)) ?? { day, bars: {}, fx: [], tips: [], updatedAt: 0 };
    const bars: Record<string, Bar[]> = { ...existing.bars };
    for (const [symbol, list] of Object.entries(incoming.bars ?? {})) {
      bars[symbol] = mergeBars(existing.bars[symbol] ?? [], list);
    }
    const fx = incoming.fx ? mergeBars(existing.fx, incoming.fx) : existing.fx;
    // Preserve any breadcrumbs already recorded for the day — a bar fetch must
    // never wipe the live-tip trail.
    const merged: StoredSession = { day, bars, fx, tips: existing.tips ?? [], updatedAt: now };
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
    tip: CurvePoint,
    options: { spacingMs?: number; maxTips?: number } = {},
  ): Promise<CurvePoint[]> {
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
    await this.saveSession(merged);
    return bounded;
  }

  /** All stored trading days, ascending. */
  async listDays(): Promise<string[]> {
    return (await this.backend.keys()).sort();
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
   */
  async clear(): Promise<void> {
    for (const key of await this.backend.keys()) {
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
