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
  quoteCacheMinutes: "iv.web.quote_cache_minutes",
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
  /** Quote-cache freshness in minutes (free-tier credit economy knob). */
  quoteCacheMinutes: number;
}

/** Clamp a parsed cache-minutes value to a sane 1–240 range, with a default. */
function parseCacheMinutes(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUOTE_CACHE_MINUTES;
  return Math.min(240, Math.round(n));
}

/** A blank, unconfigured config — used as the initial in-memory state. */
export function defaultConfig(): AppConfig {
  return {
    apiKey: "",
    repo: "",
    releaseTag: DEFAULT_RELEASE_TAG,
    blobUrl: "",
    metaUrl: "",
    quoteCacheMinutes: DEFAULT_QUOTE_CACHE_MINUTES,
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
    quoteCacheMinutes: parseCacheMinutes(read(KEYS.quoteCacheMinutes)),
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await saveApiKey(config.apiKey.trim());
  write(KEYS.repo, config.repo.trim());
  write(KEYS.releaseTag, config.releaseTag.trim());
  write(KEYS.blobUrl, config.blobUrl.trim());
  write(KEYS.metaUrl, config.metaUrl.trim());
  write(KEYS.quoteCacheMinutes, String(config.quoteCacheMinutes));
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

export { DEFAULT_RELEASE_TAG, ASSET_NAME, META_ASSET_NAME, DEFAULT_QUOTE_CACHE_MINUTES };
