/**
 * Per-device configuration, persisted in `localStorage`.
 *
 * Device-local preferences live here: the Twelve Data API key (entered once per
 * device per the proposal §6.2), the source repository, and the release tag the
 * encrypted blob is published under. The mobile passphrase is NEVER persisted —
 * it is held in memory only for the current session.
 *
 * The API key is the one secret among these, so it is encrypted at rest (see
 * `secret-store.ts`): `localStorage` holds only ciphertext, never the raw token.
 * Reading/writing the key is therefore async, which is why `loadConfig` and
 * `saveConfig` return promises.
 */

import { createSecretBox, looksEncrypted } from "./secret-store";

const KEYS = {
  apiKey: "iv.web.twelvedata_api_key",
  repo: "iv.web.repo",
  releaseTag: "iv.web.release_tag",
  blobUrl: "iv.web.blob_url",
  metaUrl: "iv.web.meta_url",
  priceProxyUrl: "iv.web.price_proxy_url",
  quoteCacheMinutes: "iv.web.quote_cache_minutes",
  autoLockMinutes: "iv.web.auto_lock_minutes",
  autoRefreshMinutes: "iv.web.auto_refresh_minutes",
} as const;

const DEFAULT_RELEASE_TAG = "live-data";
const ASSET_NAME = "portfolio.enc";
/**
 * Tiny sidecar published next to {@link ASSET_NAME} by the desktop app. It holds
 * just a version stamp (a hash of the encrypted blob) so the companion can ask
 * "is there a newer export?" by downloading a few bytes instead of the whole
 * ciphertext. See `web/proxy/` and the desktop `publish_service`.
 */
const META_ASSET_NAME = "portfolio.meta.json";
/**
 * Default quote-cache freshness (minutes). Tuned for the Twelve Data free tier
 * (8 credits/min, 800/day, 1 credit per symbol): a longer window means fewer
 * refetches and fewer credits spent, at the cost of slightly older prices.
 */
const DEFAULT_QUOTE_CACHE_MINUTES = 15;
/**
 * Default idle auto-lock timeout (minutes). After this many minutes without any
 * interaction the companion clears the in-memory passphrase and returns to the
 * unlock screen, so an unattended phone doesn't sit on an unlocked dashboard.
 * Tuned as a sensible preset for a quick-check companion; configurable, and
 * `0` disables auto-lock entirely.
 */
const DEFAULT_AUTO_LOCK_MINUTES = 5;
/** Upper bound for the configurable idle auto-lock timeout, in minutes. */
const MAX_AUTO_LOCK_MINUTES = 240;
/**
 * Default steady-state auto-refresh interval (minutes). This is the cadence the
 * background price refresh settles into once everything is fresh, and the gap
 * before the next automatic refresh after an off-cycle manual tap. Five minutes
 * keeps prices current without burning through the free-tier daily budget.
 */
const DEFAULT_AUTO_REFRESH_MINUTES = 5;
/** Upper bound for the configurable auto-refresh interval, in minutes. */
const MAX_AUTO_REFRESH_MINUTES = 120;

/** Wraps/unwraps the API key with a non-extractable per-device key (IndexedDB). */
const secrets = createSecretBox();

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage may be unavailable (private mode); config just won't persist. */
  }
}

export interface AppConfig {
  apiKey: string;
  repo: string;
  releaseTag: string;
  blobUrl: string;
  /**
   * Advanced override for the version-stamp (`portfolio.meta.json`) endpoint.
   * Empty by default — it is then derived from {@link resolveBlobUrl}. Set it
   * only when the meta sidecar lives somewhere the derivation can't guess.
   */
  metaUrl: string;
  /**
   * Advanced override for the Tiingo price-fallback proxy (`web/proxy/` Worker
   * `/price` route). Empty by default — it is then derived from the blob Worker
   * origin via {@link resolvePriceProxyUrl}. Set it only when the price proxy
   * lives somewhere the derivation can't guess. The browser stays Tiingo-keyless;
   * the token lives only in the Worker.
   */
  priceProxyUrl: string;
  /** Quote-cache freshness in minutes (free-tier credit economy knob). */
  quoteCacheMinutes: number;
  /**
   * Idle auto-lock timeout in minutes. After this long without interaction the
   * session locks itself; `0` disables auto-lock.
   */
  autoLockMinutes: number;
  /**
   * Steady-state auto-refresh interval in minutes. The background price refresh
   * relaxes to this cadence once everything is fresh, and the next automatic
   * refresh after an off-cycle manual tap is pushed out by this much.
   */
  autoRefreshMinutes: number;
}

/** Clamp a parsed cache-minutes value to a sane 1–240 range, with a default. */
function parseCacheMinutes(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUOTE_CACHE_MINUTES;
  return Math.min(240, Math.round(n));
}

/**
 * Clamp a parsed auto-lock value to `0`–{@link MAX_AUTO_LOCK_MINUTES}. A blank
 * value (never set, or a field the user cleared) falls back to the preset
 * {@link DEFAULT_AUTO_LOCK_MINUTES}; an explicit `0` — or any other non-positive
 * value — means "never lock". Exported so the Settings UI clamps identically.
 */
export function parseAutoLockMinutes(raw: string): number {
  if (raw.trim() === "") return DEFAULT_AUTO_LOCK_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_AUTO_LOCK_MINUTES, Math.round(n));
}

/**
 * Clamp a parsed auto-refresh interval to `1`–{@link MAX_AUTO_REFRESH_MINUTES}
 * minutes, falling back to {@link DEFAULT_AUTO_REFRESH_MINUTES} for a blank or
 * non-positive value. Exported so the Settings UI clamps identically.
 */
export function parseAutoRefreshMinutes(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUTO_REFRESH_MINUTES;
  return Math.min(MAX_AUTO_REFRESH_MINUTES, Math.round(n));
}

/** A blank, unconfigured config — used as the initial in-memory state. */
export function defaultConfig(): AppConfig {
  return {
    apiKey: "",
    repo: "",
    releaseTag: DEFAULT_RELEASE_TAG,
    blobUrl: "",
    metaUrl: "",
    priceProxyUrl: "",
    quoteCacheMinutes: DEFAULT_QUOTE_CACHE_MINUTES,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    autoRefreshMinutes: DEFAULT_AUTO_REFRESH_MINUTES,
  };
}

/**
 * Decrypt the persisted API key. Returns "" when none is stored or the stored
 * ciphertext can't be read (e.g. the device key is gone, or crypto/IndexedDB is
 * unavailable). A legacy plaintext key written by an older build is adopted and
 * transparently upgraded to ciphertext on read.
 */
async function loadApiKey(): Promise<string> {
  const stored = read(KEYS.apiKey);
  if (!stored) return "";
  if (!looksEncrypted(stored)) {
    await saveApiKey(stored); // migrate the legacy plaintext token to ciphertext
    return stored;
  }
  try {
    return await secrets.decrypt(stored);
  } catch {
    return "";
  }
}

/** Encrypt and persist the API key, or clear it when blank. */
async function saveApiKey(apiKey: string): Promise<void> {
  if (!apiKey) {
    write(KEYS.apiKey, "");
    return;
  }
  try {
    write(KEYS.apiKey, await secrets.encrypt(apiKey));
  } catch {
    /* crypto/IndexedDB unavailable (e.g. private mode); skip persisting the key. */
  }
}

export async function loadConfig(): Promise<AppConfig> {
  return {
    apiKey: await loadApiKey(),
    repo: read(KEYS.repo),
    releaseTag: read(KEYS.releaseTag) || DEFAULT_RELEASE_TAG,
    blobUrl: read(KEYS.blobUrl),
    metaUrl: read(KEYS.metaUrl),
    priceProxyUrl: read(KEYS.priceProxyUrl),
    quoteCacheMinutes: parseCacheMinutes(read(KEYS.quoteCacheMinutes)),
    autoLockMinutes: parseAutoLockMinutes(read(KEYS.autoLockMinutes)),
    autoRefreshMinutes: parseAutoRefreshMinutes(read(KEYS.autoRefreshMinutes)),
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await saveApiKey(config.apiKey.trim());
  write(KEYS.repo, config.repo.trim());
  write(KEYS.releaseTag, config.releaseTag.trim());
  write(KEYS.blobUrl, config.blobUrl.trim());
  write(KEYS.metaUrl, config.metaUrl.trim());
  write(KEYS.priceProxyUrl, config.priceProxyUrl.trim());
  write(KEYS.quoteCacheMinutes, String(config.quoteCacheMinutes));
  write(KEYS.autoLockMinutes, String(config.autoLockMinutes));
  write(KEYS.autoRefreshMinutes, String(config.autoRefreshMinutes));
}

/** A loosely-validated `owner/name` slug, matching the publisher's guard. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.includes("..");
}

/**
 * Resolve the URL to download the encrypted blob from. An explicit `blobUrl`
 * override wins; otherwise it is the release-asset download URL built from the
 * repo + tag (the route the desktop publisher uploads to).
 *
 * NOTE (CORS): the release-asset download URL is NOT readable from a browser on
 * a different origin — GitHub's `releases/download/...` endpoint redirects to
 * `release-assets.githubusercontent.com`, which sends no `Access-Control-Allow-Origin`
 * header, so a cross-origin `fetch()` fails with "Failed to fetch". To serve the
 * blob to the hosted web app, set `blobUrl` to a CORS-enabled source — e.g. the
 * Cloudflare Worker proxy in `web/proxy/`, which fetches the release asset
 * server-side and re-emits it with permissive CORS headers. The release-asset
 * default below is kept for same-origin/local use and as a documented fallback.
 */
export function resolveBlobUrl(config: AppConfig): string | null {
  if (config.blobUrl) return config.blobUrl;
  if (!isValidRepo(config.repo)) return null;
  const tag = encodeURIComponent(config.releaseTag || DEFAULT_RELEASE_TAG);
  return `https://github.com/${config.repo}/releases/download/${tag}/${ASSET_NAME}`;
}

/**
 * Resolve the URL of the lightweight version sidecar (`portfolio.meta.json`),
 * used to cheaply detect "is there a newer export?" before pulling the full
 * blob. Precedence:
 *
 *  1. an explicit {@link AppConfig.metaUrl} override, if set;
 *  2. otherwise *derive* it from {@link resolveBlobUrl}:
 *     - when a `blobUrl` proxy override is in play, the same endpoint with a
 *       `?meta` flag (the `web/proxy/` Worker serves the sidecar that way), or
 *     - the release-asset default with the filename swapped to the meta asset.
 *
 * Returns `null` only when there is no data source at all. The meta check is
 * best-effort: callers fall back to a conditional/full blob download if the
 * sidecar can't be fetched (e.g. an older proxy, or the desktop app hasn't
 * published a meta file yet).
 */
export function resolveMetaUrl(config: AppConfig): string | null {
  if (config.metaUrl) return config.metaUrl;
  if (config.blobUrl) {
    // A custom blob endpoint (typically the CORS proxy Worker) exposes the
    // sidecar via a `?meta` flag rather than a sibling path.
    return config.blobUrl + (config.blobUrl.includes("?") ? "&" : "?") + "meta";
  }
  if (!isValidRepo(config.repo)) return null;
  const tag = encodeURIComponent(config.releaseTag || DEFAULT_RELEASE_TAG);
  return `https://github.com/${config.repo}/releases/download/${tag}/${META_ASSET_NAME}`;
}

/**
 * Resolve the URL of the Tiingo price-fallback proxy (the `web/proxy/` Worker
 * `/price` route). Precedence:
 *
 *  1. an explicit {@link AppConfig.priceProxyUrl} override, if set;
 *  2. otherwise *derive* it from the blob Worker origin — `<origin>/price` — so
 *     wiring up the blob proxy is enough to get the price fallback too. The blob
 *     `blobUrl` override is the Worker URL the user already pasted; the price
 *     route hangs off the same Worker at `/price`.
 *
 * Returns `null` when there is no proxy to derive from (no `blobUrl` override and
 * no explicit price proxy). The Tiingo fallback is then simply unavailable — the
 * app keeps working on Twelve Data alone. The browser never holds a Tiingo token;
 * it lives only in the Worker, so this URL is the *only* thing the client needs.
 */
export function resolvePriceProxyUrl(config: AppConfig): string | null {
  if (config.priceProxyUrl) return config.priceProxyUrl;
  // The price route can only be derived from an explicit Worker (`blobUrl`)
  // origin: the bare GitHub release-asset default is not a Worker and has no
  // `/price` route, so deriving from it would point at nothing useful.
  if (!config.blobUrl) return null;
  try {
    return new URL("/price", config.blobUrl).toString();
  } catch {
    return null;
  }
}

export { DEFAULT_RELEASE_TAG, ASSET_NAME, META_ASSET_NAME, DEFAULT_QUOTE_CACHE_MINUTES, DEFAULT_AUTO_LOCK_MINUTES, MAX_AUTO_LOCK_MINUTES, DEFAULT_AUTO_REFRESH_MINUTES, MAX_AUTO_REFRESH_MINUTES };