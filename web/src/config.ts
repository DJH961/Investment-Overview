/**
 * Per-device configuration, persisted in `localStorage`.
 *
 * A working companion needs just three things: the Twelve Data API key (the
 * live-quote credential), the data-source URL (a CORS-enabled endpoint — in
 * practice the Cloudflare Worker in `web/proxy/` — that serves the encrypted
 * portfolio blob), and how often to refresh prices. The mobile passphrase is
 * NEVER persisted: it is held in memory only for the current session.
 *
 * The API key is the one secret among these, so it is encrypted at rest (see
 * `secret-store.ts`): `localStorage` holds only ciphertext, never the raw token.
 * Reading/writing the key is therefore async, which is why `loadConfig` and
 * `saveConfig` return promises.
 *
 * Earlier builds exposed a pile of data-source plumbing (repo, release tag,
 * separate blob/meta overrides) and two timing knobs (quote-cache vs
 * auto-refresh). Those collapsed into a single data-source URL and a single
 * "update every N minutes" interval; {@link loadConfig} migrates any legacy
 * values forward once, and {@link saveConfig} retires the old keys.
 */

import { createSecretBox, looksEncrypted } from "./secret-store";

const KEYS = {
  apiKey: "iv.web.twelvedata_api_key",
  blobUrl: "iv.web.blob_url",
  updateMinutes: "iv.web.update_minutes",
  autoLockMinutes: "iv.web.auto_lock_minutes",
} as const;

/**
 * Pre-simplification storage keys. Read once by {@link loadConfig} so an
 * existing install migrates seamlessly, then cleared by {@link saveConfig}.
 */
const LEGACY_KEYS = {
  repo: "iv.web.repo",
  releaseTag: "iv.web.release_tag",
  metaUrl: "iv.web.meta_url",
  quoteCacheMinutes: "iv.web.quote_cache_minutes",
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
 * Default price-refresh interval (minutes). This single knob drives both the
 * background wake cadence and the quote-cache freshness window, so prices are
 * re-pulled roughly every N minutes. Tuned for the Twelve Data free tier
 * (8 credits/min, 800/day, 1 credit per symbol): a longer window means fewer
 * refetches and fewer credits spent, at the cost of slightly older prices.
 */
const DEFAULT_UPDATE_MINUTES = 15;
/** Upper bound for the configurable price-refresh interval, in minutes. */
const MAX_UPDATE_MINUTES = 240;
/**
 * Default idle auto-lock timeout (minutes). After this many minutes without any
 * interaction the companion clears the in-memory passphrase and returns to the
 * unlock screen, so an unattended phone doesn't sit on an unlocked dashboard.
 * Configurable, and `0` disables auto-lock entirely.
 */
const DEFAULT_AUTO_LOCK_MINUTES = 5;
/** Upper bound for the configurable idle auto-lock timeout, in minutes. */
const MAX_AUTO_LOCK_MINUTES = 240;

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
  /**
   * CORS-enabled endpoint that serves the encrypted portfolio blob — typically
   * the Cloudflare Worker proxy in `web/proxy/`. This is the single source of
   * truth for where the data lives; the version sidecar is derived from it (see
   * {@link resolveMetaUrl}).
   */
  blobUrl: string;
  /**
   * Price-refresh interval in minutes. Drives both how often the background
   * refresh wakes and how stale a cached quote may get before it is re-pulled.
   */
  updateMinutes: number;
  /**
   * Idle auto-lock timeout in minutes. After this long without interaction the
   * session locks itself; `0` disables auto-lock.
   */
  autoLockMinutes: number;
}

/**
 * Clamp a parsed update-interval to `1`–{@link MAX_UPDATE_MINUTES} minutes,
 * falling back to {@link DEFAULT_UPDATE_MINUTES} for a blank or non-positive
 * value. Exported so the setup/Settings UI clamps identically.
 */
export function parseUpdateMinutes(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_UPDATE_MINUTES;
  return Math.min(MAX_UPDATE_MINUTES, Math.max(1, Math.round(n)));
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

/** A blank, unconfigured config — used as the initial in-memory state. */
export function defaultConfig(): AppConfig {
  return {
    apiKey: "",
    blobUrl: "",
    updateMinutes: DEFAULT_UPDATE_MINUTES,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
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

/**
 * One-time migration of the legacy data-source plumbing into a single blob URL.
 * Older installs stored `repo` + `releaseTag` (and optionally a `blobUrl`
 * override). When no new-style blob URL is present but a legacy repo is, rebuild
 * the release-asset download URL so the data source survives the upgrade.
 */
function migrateLegacyBlobUrl(): string {
  const repo = read(LEGACY_KEYS.repo);
  if (!isValidRepo(repo)) return "";
  const tag = encodeURIComponent(read(LEGACY_KEYS.releaseTag) || DEFAULT_RELEASE_TAG);
  return `https://github.com/${repo}/releases/download/${tag}/${ASSET_NAME}`;
}

/**
 * One-time migration of the two legacy timing knobs into one interval. The old
 * quote-cache window governed how stale a price could get before a refetch, so
 * it best preserves perceived freshness; fall back to the old auto-refresh
 * cadence, then the default.
 */
function readLegacyUpdateMinutes(): string {
  return read(LEGACY_KEYS.quoteCacheMinutes) || read(LEGACY_KEYS.autoRefreshMinutes) || "";
}

export async function loadConfig(): Promise<AppConfig> {
  return {
    apiKey: await loadApiKey(),
    blobUrl: read(KEYS.blobUrl) || migrateLegacyBlobUrl(),
    updateMinutes: parseUpdateMinutes(read(KEYS.updateMinutes) || readLegacyUpdateMinutes()),
    autoLockMinutes: parseAutoLockMinutes(read(KEYS.autoLockMinutes)),
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await saveApiKey(config.apiKey.trim());
  write(KEYS.blobUrl, config.blobUrl.trim());
  write(KEYS.updateMinutes, String(config.updateMinutes));
  write(KEYS.autoLockMinutes, String(config.autoLockMinutes));
  // Retire the legacy keys now that their data lives in the simplified shape, so
  // the migration only fires once and old plumbing doesn't linger in storage.
  for (const legacyKey of Object.values(LEGACY_KEYS)) write(legacyKey, "");
}

/** A loosely-validated `owner/name` slug, matching the publisher's guard. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.includes("..");
}

/**
 * Resolve the URL to download the encrypted blob from: simply the configured
 * data-source URL, or `null` when none is set.
 *
 * NOTE (CORS): a raw GitHub `releases/download/...` URL is NOT readable from a
 * browser on a different origin — it redirects to `release-assets.githubusercontent.com`,
 * which sends no `Access-Control-Allow-Origin` header, so a cross-origin
 * `fetch()` fails. The hosted companion therefore points at a CORS-enabled
 * source — the Cloudflare Worker proxy in `web/proxy/`, which fetches the
 * release asset server-side and re-emits it with permissive CORS headers.
 */
export function resolveBlobUrl(config: AppConfig): string | null {
  return config.blobUrl ? config.blobUrl : null;
}

/**
 * Resolve the URL of the lightweight version sidecar (`portfolio.meta.json`),
 * used to cheaply detect "is there a newer export?" before pulling the full
 * blob. Derived from {@link AppConfig.blobUrl}:
 *
 *  - a GitHub release-asset blob has the sidecar as a sibling file, so swap the
 *    `portfolio.enc` filename for `portfolio.meta.json`;
 *  - any other endpoint (the proxy Worker) serves the sidecar via a `?meta` flag
 *    on the same URL.
 *
 * Returns `null` only when there is no data source. The meta check is
 * best-effort: callers fall back to a conditional/full blob download if the
 * sidecar can't be fetched.
 */
export function resolveMetaUrl(config: AppConfig): string | null {
  const blob = config.blobUrl;
  if (!blob) return null;
  if (blob.endsWith("/" + ASSET_NAME)) {
    return blob.slice(0, blob.length - ASSET_NAME.length) + META_ASSET_NAME;
  }
  return blob + (blob.includes("?") ? "&" : "?") + "meta";
}

// --- Portable config packet (export / import) --------------------------------

/** Discriminator stamped into an exported packet so imports can sanity-check it. */
const CONFIG_PACKET_TYPE = "investment-overview-config";
/** Bump when the packet shape changes incompatibly. */
const CONFIG_PACKET_VERSION = 1;

/**
 * The on-disk shape of an exported config packet. Currently a plaintext JSON
 * file the user keeps private (Plan A). The `type`/`version` stamps leave room
 * for a future passphrase-encrypted, Worker-published variant (Plan B) without
 * breaking older importers.
 */
export interface ConfigPacket {
  type: typeof CONFIG_PACKET_TYPE;
  version: number;
  apiKey: string;
  blobUrl: string;
  updateMinutes: number;
  autoLockMinutes: number;
}

/** Serialize the portable parts of a config to a pretty JSON packet string. */
export function serializeConfig(config: AppConfig): string {
  const packet: ConfigPacket = {
    type: CONFIG_PACKET_TYPE,
    version: CONFIG_PACKET_VERSION,
    apiKey: config.apiKey,
    blobUrl: config.blobUrl,
    updateMinutes: config.updateMinutes,
    autoLockMinutes: config.autoLockMinutes,
  };
  return JSON.stringify(packet, null, 2);
}

/**
 * Parse and validate an imported config packet into an {@link AppConfig}.
 * Throws a user-facing `Error` when the text isn't a recognisable packet.
 * Numeric fields are clamped through the same parsers as manual entry.
 */
export function parseConfigPacket(text: string): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("That file isn't an Investment Overview config.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type !== CONFIG_PACKET_TYPE) {
    throw new Error("That file isn't an Investment Overview config.");
  }
  if (obj.version !== CONFIG_PACKET_VERSION) {
    throw new Error("That config file version isn't supported by this build.");
  }
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey.trim() : "";
  const blobUrl = typeof obj.blobUrl === "string" ? obj.blobUrl.trim() : "";
  return {
    apiKey,
    blobUrl,
    updateMinutes: parseUpdateMinutes(String(obj.updateMinutes ?? "")),
    autoLockMinutes: parseAutoLockMinutes(String(obj.autoLockMinutes ?? "")),
  };
}

export {
  DEFAULT_RELEASE_TAG,
  ASSET_NAME,
  META_ASSET_NAME,
  DEFAULT_UPDATE_MINUTES,
  MAX_UPDATE_MINUTES,
  DEFAULT_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  CONFIG_PACKET_TYPE,
  CONFIG_PACKET_VERSION,
};
