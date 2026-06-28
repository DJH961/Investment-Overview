/**
 * The **core-vs-bonus data registry** and the device-store *reloadability
 * contract* (long-range value-history plan, item 2).
 *
 * Every value the companion persists on the device falls into exactly one of two
 * buckets:
 *
 *  - **`core`** — data the app *guarantees* it can reload from scratch on demand
 *    or on an empty device: the live prices, the EUR/USD FX, the 1D intraday
 *    bars, the 1W daily-close sleeve, and the long-range whole-book value
 *    history. Losing any of these is never fatal: a load path (an orchestrator
 *    leg, the blob, or a reconstruction) always exists to rebuild it.
 *  - **`bonus`** — data that merely *enriches* the picture and may be lost
 *    forever without breaking any core value: the live-tip **breadcrumbs/tips**
 *    that thicken a watched-live curve, and the human-readable polling log. These
 *    have no reload path by design — they are recorded opportunistically and are
 *    disposable.
 *
 * Making the bucket explicit turns an implicit assumption ("the hard reset is
 * safe because everything reloads") into a *checked contract*: {@link
 * timeSeriesStoreBucket} classifies every {@link TimeSeriesStore} key a wipe
 * touches, {@link TimeSeriesStore.clear} consults it so the wipe states its
 * intent, and `web/test/data-registry.test.ts` asserts every known store is
 * enumerated — so any **future** store is forced to declare which bucket it is
 * in (and, if `core`, how it reloads) rather than silently becoming an
 * unrecoverable value.
 *
 * This module deliberately depends on **nothing** from the storage layer (it
 * uses bare key literals, mirrored by a drift test against the real
 * `VALUE_HISTORY_STORE_KEY` / `WEEK_STORE_KEY` constants) so it can be imported
 * by `timeseries-store.ts` without a cycle.
 */

/** Which recoverability bucket a device store belongs to. */
export type DataBucket = "core" | "bonus";

/** One enumerated device store and its reloadability contract. */
export interface DeviceStoreSpec {
  /** Stable logical id for the store. */
  id: string;
  /** `core` (must be reloadable) or `bonus` (may be lost). */
  bucket: DataBucket;
  /** What the store holds, in one line. */
  summary: string;
  /**
   * For a `core` store, how it is reloaded from scratch (the load path that
   * makes losing it non-fatal). Empty string for a `bonus` store, which has
   * none by design.
   */
  reloadPath: string;
}

/**
 * The {@link TimeSeriesStore} key the 1W daily-close sleeve lives under. Mirrors
 * `week.WEEK_STORE_KEY`; kept as a literal here to avoid importing the storage
 * layer (the drift test pins them equal).
 */
export const WEEK_STORE_KEY_LITERAL = "1W-daily";

/**
 * The {@link TimeSeriesStore} key the whole-book value history lives under.
 * Mirrors `value-history.VALUE_HISTORY_STORE_KEY`; literal here to avoid an
 * import cycle (the drift test pins them equal).
 */
export const VALUE_HISTORY_STORE_KEY_LITERAL = "value-history";

/**
 * Every device store, bucketed. `core` stores each carry a concrete reload path;
 * `bonus` stores carry none. New stores **must** be added here (the registry
 * completeness test fails otherwise), forcing the bucket decision to be explicit.
 */
export const DEVICE_STORES: readonly DeviceStoreSpec[] = [
  {
    id: "prices",
    bucket: "core",
    summary: "Cached live per-symbol quotes (last-known prices).",
    reloadPath: "orchestrator quote/nav legs re-fetch from the price provider.",
  },
  {
    id: "fx",
    bucket: "core",
    summary: "Cached EUR/USD spot + per-session settled FX rates.",
    reloadPath: "orchestrator fx/fxBars legs (live spot + Tiingo fxHistory) re-fetch; blob settled rate as the weekend/holiday fallback.",
  },
  {
    id: "session-1d",
    bucket: "core",
    summary: "Per-session 1D intraday bar series (dated TimeSeriesStore keys).",
    reloadPath: "orchestrator dayBars leg / Regenerate 1D re-pulls the session bars from scratch.",
  },
  {
    id: "week-1w",
    bucket: "core",
    summary: "1W daily-close sleeve (one daily close per market symbol).",
    reloadPath: "orchestrator weekBars leg / Regenerate 1W re-pulls the daily closes from scratch.",
  },
  {
    id: "value-history",
    bucket: "core",
    summary: "Long-range whole-book daily-close value history (1M–1Y graph).",
    reloadPath: "blob analytics.curve + multi-month daily-bar reconstruction (loadOrBuildLongRangeHistory) / Regenerate long-range rebuilds it from scratch.",
  },
  {
    id: "breadcrumbs",
    bucket: "bonus",
    summary: "Live-tip breadcrumb trails that thicken a watched-live curve.",
    reloadPath: "",
  },
  {
    id: "polling-log",
    bucket: "bonus",
    summary: "Human-readable data-polling transparency log.",
    reloadPath: "",
  },
] as const;

/** Look up a store spec by id, or `undefined` when unknown. */
export function storeSpec(id: string): DeviceStoreSpec | undefined {
  return DEVICE_STORES.find((s) => s.id === id);
}

/** Every `core` store — the values that **must** stay reloadable. */
export function coreStores(): DeviceStoreSpec[] {
  return DEVICE_STORES.filter((s) => s.bucket === "core");
}

/** Every `bonus` store — the values that **may** be lost. */
export function bonusStores(): DeviceStoreSpec[] {
  return DEVICE_STORES.filter((s) => s.bucket === "bonus");
}

/** A genuine `YYYY-MM-DD` session key — the per-session 1D bar caches. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The registry id a {@link TimeSeriesStore} key maps to:
 *   - a `YYYY-MM-DD` dated key → `"session-1d"`,
 *   - {@link WEEK_STORE_KEY_LITERAL} → `"week-1w"`,
 *   - {@link VALUE_HISTORY_STORE_KEY_LITERAL} → `"value-history"`,
 *   - anything else → `null` (an *unregistered* key — a contract violation a
 *     caller may surface so a new store cannot slip through unclassified).
 *
 * Note: the live-tip breadcrumbs (`bonus`) ride **inside** the dated 1D session
 * records, so they are wiped together with the `core` 1D bars — losing the bonus
 * trail is harmless and the core bars reload, exactly as the contract intends.
 */
export function timeSeriesStoreId(key: string): string | null {
  if (DATE_KEY_RE.test(key)) return "session-1d";
  if (key === WEEK_STORE_KEY_LITERAL) return "week-1w";
  if (key === VALUE_HISTORY_STORE_KEY_LITERAL) return "value-history";
  return null;
}

/**
 * The recoverability bucket a {@link TimeSeriesStore} key belongs to, or `null`
 * when the key is not registered. Every key this store persists today is `core`
 * (the 1D/1W/long-range value series); the `bonus` breadcrumbs ride inside the
 * core 1D records rather than under their own key.
 */
export function timeSeriesStoreBucket(key: string): DataBucket | null {
  const id = timeSeriesStoreId(key);
  if (id === null) return null;
  return storeSpec(id)?.bucket ?? null;
}

/** A wipe summary, grouping the cleared keys by bucket plus any unregistered. */
export interface ClearSummary {
  /** Cleared keys that map to a `core` store. */
  core: string[];
  /** Cleared keys that map to a `bonus` store. */
  bonus: string[];
  /** Cleared keys with **no** registry entry — a contract violation to surface. */
  unregistered: string[];
}

/** Group a set of about-to-be-cleared keys by their registry bucket. */
export function summarizeClear(keys: Iterable<string>): ClearSummary {
  const summary: ClearSummary = { core: [], bonus: [], unregistered: [] };
  for (const key of keys) {
    const bucket = timeSeriesStoreBucket(key);
    if (bucket === "core") summary.core.push(key);
    else if (bucket === "bonus") summary.bonus.push(key);
    else summary.unregistered.push(key);
  }
  return summary;
}
