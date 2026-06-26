/**
 * Opt-in, tab-scoped "resume token" that lets a full-page reload (F5) pick the
 * unlocked session back up — like pressing the manual refresh button — without
 * ever weakening the "closed tab / idle ⇒ locked" guarantees.
 *
 * Why `sessionStorage`: its lifetime is exactly what we want. It survives an F5
 * reload of *this* tab, is wiped when the tab/window is closed, and is never
 * shared with other tabs. So a token that lives here naturally dies on a real
 * tab close — there is nothing to clean up and nothing for another tab to read.
 *
 * Why it stays safe: we never store the passphrase in the clear. The token holds
 * only the **ciphertext** of the passphrase, wrapped with the same non-extractable
 * per-device AES-GCM key kept in IndexedDB (see {@link createSecretBox} /
 * `secret-store.ts`). The two halves are useless apart:
 *   - the ciphertext alone (sessionStorage) is inert without the IndexedDB key;
 *   - the IndexedDB key alone is useless once the tab closes and sessionStorage
 *     is gone.
 *
 * Three more guards keep a resume strictly no weaker than staying on the page:
 *   1. **reload-only** — the caller activates this path only for a reload /
 *      back-forward navigation (see {@link isReloadNavigation}), never a fresh
 *      cold navigation;
 *   2. **idle window** — the token stamps the last genuine in-app activity; a
 *      resume is refused once that exceeds the configured auto-lock window (or a
 *      hard cap when auto-lock is set to "never"), so an idle-expired session
 *      still re-authenticates;
 *   3. **context binding** — the token is bound to the app build version and the
 *      data-source URL in force when it was minted, so it can't apply after an
 *      upgrade or a data-source change.
 */

import { createSecretBox, type SecretBox } from "./secret-store";
import { APP_VERSION } from "./version";

/** sessionStorage key holding the (opaque) resume token. */
const RESUME_KEY = "iv.web.resume";
/** Envelope shape version, so the token format can evolve without misreads. */
export const RESUME_TOKEN_VERSION = 1;
/**
 * Hard cap on how long a resume token stays valid when auto-lock is disabled
 * (`autoLockMinutes === 0`, "never lock"). Even "never" shouldn't mean a token
 * survives an open tab indefinitely, so cap it at a few hours.
 */
export const RESUME_NEVER_LOCK_HARD_CAP_MS = 4 * 60 * 60_000;
/**
 * Small tolerance for a future-dated activity stamp (clock nudge / DST) before
 * we treat the token as bogus and refuse it.
 */
const RESUME_CLOCK_SKEW_MS = 60_000;

/** The on-the-wire shape persisted in sessionStorage. */
export interface ResumeTokenEnvelope {
  /** Envelope shape version ({@link RESUME_TOKEN_VERSION}). */
  t: number;
  /** App build version this token was minted under. */
  v: string;
  /** Context binding: the data-source (blob) URL in force at mint time. */
  ctx: string;
  /** Last genuine in-app activity, epoch ms. */
  at: number;
  /** Wrapped (encrypted) passphrase — never the plaintext. */
  secret: string;
}

/** Minimal storage seam so tests need no real `sessionStorage`. */
export interface ResumeStorage {
  get(): string | null;
  set(value: string): void;
  remove(): void;
}

/** Default storage: `sessionStorage`, guarded for private-mode/unavailable. */
export function sessionResumeStorage(): ResumeStorage {
  return {
    get() {
      try {
        return sessionStorage.getItem(RESUME_KEY);
      } catch {
        return null;
      }
    },
    set(value: string) {
      try {
        sessionStorage.setItem(RESUME_KEY, value);
      } catch {
        /* sessionStorage may be unavailable (private mode); resume just won't persist. */
      }
    },
    remove() {
      try {
        sessionStorage.removeItem(RESUME_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Memoised default secret box (wraps with the per-device IndexedDB key). */
let defaultBoxCache: SecretBox | null = null;
function defaultBox(): SecretBox {
  if (!defaultBoxCache) defaultBoxCache = createSecretBox();
  return defaultBoxCache;
}

/**
 * Idle ceiling for a resume, in ms: the configured auto-lock window, or the
 * {@link RESUME_NEVER_LOCK_HARD_CAP_MS} cap when auto-lock is disabled.
 */
export function resumeIdleLimitMs(autoLockMinutes: number): number {
  return autoLockMinutes > 0 ? autoLockMinutes * 60_000 : RESUME_NEVER_LOCK_HARD_CAP_MS;
}

/**
 * Detect a reload / back-forward restore (as opposed to a fresh cold
 * navigation), so the resume path only activates when the user genuinely
 * reloaded *this* tab. Uses the Navigation Timing Level 2 entry, with a fallback
 * to the deprecated `performance.navigation` for older engines.
 */
export function isReloadNavigation(): boolean {
  try {
    if (typeof performance === "undefined") return false;
    const entries = performance.getEntriesByType?.("navigation") as PerformanceNavigationTiming[] | undefined;
    const nav = entries?.[0];
    if (nav && typeof nav.type === "string") {
      return nav.type === "reload" || nav.type === "back_forward";
    }
    const legacy = (performance as unknown as { navigation?: { type?: number } }).navigation;
    if (legacy && typeof legacy.type === "number") {
      // 1 = TYPE_RELOAD, 2 = TYPE_BACK_FORWARD
      return legacy.type === 1 || legacy.type === 2;
    }
  } catch {
    /* performance API unavailable; treat as not-a-reload (safer default). */
  }
  return false;
}

/** Parse and shape-check the stored envelope, or `null` when absent/garbled. */
export function readResumeEnvelope(storage: ResumeStorage = sessionResumeStorage()): ResumeTokenEnvelope | null {
  const raw = storage.get();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ResumeTokenEnvelope> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (
      typeof parsed.t !== "number" ||
      typeof parsed.v !== "string" ||
      typeof parsed.ctx !== "string" ||
      typeof parsed.at !== "number" ||
      typeof parsed.secret !== "string"
    ) {
      return null;
    }
    return parsed as ResumeTokenEnvelope;
  } catch {
    return null;
  }
}

/**
 * Whether a stored envelope may be used to resume right now: the shape version,
 * app build version and data-source URL must all match, and the last activity
 * must fall inside the idle window (and not be implausibly in the future).
 */
export function isResumeTokenValid(
  env: ResumeTokenEnvelope | null,
  args: { now: number; appVersion: string; blobUrl: string; autoLockMinutes: number },
): boolean {
  if (!env) return false;
  if (env.t !== RESUME_TOKEN_VERSION) return false;
  if (env.v !== args.appVersion) return false;
  if (env.ctx !== args.blobUrl) return false;
  if (!env.secret) return false;
  if (env.at > args.now + RESUME_CLOCK_SKEW_MS) return false;
  return args.now - env.at <= resumeIdleLimitMs(args.autoLockMinutes);
}

/**
 * Mint (or overwrite) the resume token: wrap the passphrase with the per-device
 * key and persist the envelope. Called after every successful unlock so the
 * token always reflects the latest passphrase, version and data source.
 */
export async function saveResumeToken(args: {
  passphrase: string;
  blobUrl: string;
  now: number;
  box?: SecretBox;
  storage?: ResumeStorage;
}): Promise<void> {
  const box = args.box ?? defaultBox();
  const secret = await box.encrypt(args.passphrase);
  const env: ResumeTokenEnvelope = {
    t: RESUME_TOKEN_VERSION,
    v: APP_VERSION,
    ctx: args.blobUrl,
    at: args.now,
    secret,
  };
  (args.storage ?? sessionResumeStorage()).set(JSON.stringify(env));
}

/**
 * Re-stamp the stored token's last-activity time in place (cheap — the wrapped
 * secret is untouched). A no-op when no token exists. Callers throttle how often
 * this fires so it doesn't thrash storage on high-frequency activity events.
 */
export function touchResumeActivity(now: number, storage: ResumeStorage = sessionResumeStorage()): void {
  const env = readResumeEnvelope(storage);
  if (!env) return;
  env.at = now;
  storage.set(JSON.stringify(env));
}

/** Decrypt the wrapped passphrase back out of a (validated) envelope. */
export async function unwrapResumePassphrase(env: ResumeTokenEnvelope, box: SecretBox = defaultBox()): Promise<string> {
  return box.decrypt(env.secret);
}

/** Drop the resume token entirely (explicit lock, identity change, sign-out). */
export function clearResumeToken(storage: ResumeStorage = sessionResumeStorage()): void {
  storage.remove();
}
