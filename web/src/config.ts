/**
 * Per-device configuration, persisted in `localStorage`.
 *
 * Only non-secret, device-local preferences live here: the Twelve Data API key
 * (entered once per device per the proposal §6.2), the source repository, and
 * the release tag the encrypted blob is published under. The mobile passphrase
 * is NEVER persisted — it is held in memory only for the current session.
 */

const KEYS = {
  apiKey: "iv.web.twelvedata_api_key",
  repo: "iv.web.repo",
  releaseTag: "iv.web.release_tag",
  blobUrl: "iv.web.blob_url",
} as const;

const DEFAULT_RELEASE_TAG = "live-data";
const ASSET_NAME = "portfolio.enc";

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

// SECURITY (accepted, intentional — proposal §6.2): the Twelve Data price API
// key is deliberately persisted in localStorage so it is entered only once per
// device. It is a low-sensitivity, rate-limited, free price-data token scoped to
// the user's own account — NOT a credential to any financial data — and it never
// leaves the device or enters the repo. CodeQL's clear-text-storage rule flags
// this write; the trade-off is accepted for this token class.
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
}

export function loadConfig(): AppConfig {
  return {
    apiKey: read(KEYS.apiKey),
    repo: read(KEYS.repo),
    releaseTag: read(KEYS.releaseTag) || DEFAULT_RELEASE_TAG,
    blobUrl: read(KEYS.blobUrl),
  };
}

export function saveConfig(config: AppConfig): void {
  write(KEYS.apiKey, config.apiKey.trim());
  write(KEYS.repo, config.repo.trim());
  write(KEYS.releaseTag, config.releaseTag.trim());
  write(KEYS.blobUrl, config.blobUrl.trim());
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

export { DEFAULT_RELEASE_TAG, ASSET_NAME };
