/**
 * Resume-session token: the opt-in, tab-scoped "stay unlocked across an F5"
 * gate. These tests pin the safety-critical behaviour — the passphrase only ever
 * persists as ciphertext, and a resume is refused whenever it would be weaker
 * than staying on the page (idle-expired, wrong app version, wrong data source,
 * or after a tab close).
 *
 * Uses an in-memory `KeyProvider` (a single non-extractable AES-GCM key) and an
 * in-memory storage seam, so neither IndexedDB nor `sessionStorage` is needed in
 * the Node test environment; `crypto.subtle` is the real browser primitive.
 */
import { describe, expect, it } from "vitest";

import { createSecretBox, type KeyProvider, type SecretBox } from "../src/secret-store";
import { APP_VERSION } from "../src/version";
import {
  RESUME_NEVER_LOCK_HARD_CAP_MS,
  clearResumeToken,
  isResumeTokenValid,
  readResumeEnvelope,
  resumeIdleLimitMs,
  saveResumeToken,
  touchResumeActivity,
  unwrapResumePassphrase,
  type ResumeStorage,
  type ResumeTokenEnvelope,
} from "../src/resume-session";

async function memoryBox(): Promise<SecretBox> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const provider: KeyProvider = { getKey: () => Promise.resolve(key) };
  return createSecretBox(provider);
}

/** A throwaway in-memory `ResumeStorage` standing in for `sessionStorage`. */
function memoryStorage(): ResumeStorage & { value: string | null } {
  return {
    value: null,
    get() {
      return this.value;
    },
    set(v: string) {
      this.value = v;
    },
    remove() {
      this.value = null;
    },
  };
}

const BLOB = "https://proxy.example/portfolio.enc";

describe("resume-session token", () => {
  it("round-trips the passphrase through save → read → unwrap", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();
    const now = 1_000_000;

    await saveResumeToken({ passphrase: "correct horse battery", blobUrl: BLOB, now, box, storage });
    const env = readResumeEnvelope(storage);
    expect(env).not.toBeNull();
    expect(await unwrapResumePassphrase(env as ResumeTokenEnvelope, box)).toBe("correct horse battery");
  });

  it("never stores the passphrase in the clear", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();

    await saveResumeToken({ passphrase: "super-secret-pass", blobUrl: BLOB, now: 5, box, storage });
    expect(storage.value).not.toBeNull();
    expect(storage.value).not.toContain("super-secret-pass");
  });

  it("accepts a fresh token within the idle window", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();
    const now = 2_000_000;
    await saveResumeToken({ passphrase: "p", blobUrl: BLOB, now, box, storage });

    const env = readResumeEnvelope(storage);
    expect(
      isResumeTokenValid(env, { now: now + 60_000, appVersion: APP_VERSION, blobUrl: BLOB, autoLockMinutes: 5 }),
    ).toBe(true);
  });

  it("rejects a token past the idle (auto-lock) window", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();
    const now = 3_000_000;
    await saveResumeToken({ passphrase: "p", blobUrl: BLOB, now, box, storage });

    const env = readResumeEnvelope(storage);
    // 5-minute window; 6 minutes idle ⇒ refused.
    expect(
      isResumeTokenValid(env, { now: now + 6 * 60_000, appVersion: APP_VERSION, blobUrl: BLOB, autoLockMinutes: 5 }),
    ).toBe(false);
  });

  it("rejects a token minted under a different app version", async () => {
    const env: ResumeTokenEnvelope = { t: 1, v: "0.0.0-old", ctx: BLOB, at: 100, wrapped: "v1.aa.bb" };
    expect(
      isResumeTokenValid(env, { now: 200, appVersion: APP_VERSION, blobUrl: BLOB, autoLockMinutes: 5 }),
    ).toBe(false);
  });

  it("rejects a token bound to a different data source", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();
    await saveResumeToken({ passphrase: "p", blobUrl: BLOB, now: 100, box, storage });
    const env = readResumeEnvelope(storage);
    expect(
      isResumeTokenValid(env, {
        now: 200,
        appVersion: APP_VERSION,
        blobUrl: "https://other.example/portfolio.enc",
        autoLockMinutes: 5,
      }),
    ).toBe(false);
  });

  it("rejects a future-dated activity stamp (clock tamper)", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();
    await saveResumeToken({ passphrase: "p", blobUrl: BLOB, now: 10_000_000, box, storage });
    const env = readResumeEnvelope(storage);
    // 'now' is well before the stamp ⇒ implausible, refuse.
    expect(
      isResumeTokenValid(env, { now: 1_000_000, appVersion: APP_VERSION, blobUrl: BLOB, autoLockMinutes: 5 }),
    ).toBe(false);
  });

  it("uses the hard cap when auto-lock is disabled (never lock)", () => {
    expect(resumeIdleLimitMs(0)).toBe(RESUME_NEVER_LOCK_HARD_CAP_MS);
    expect(resumeIdleLimitMs(5)).toBe(5 * 60_000);

    const env: ResumeTokenEnvelope = { t: 1, v: APP_VERSION, ctx: BLOB, at: 0, wrapped: "v1.aa.bb" };
    // Just inside the cap is fine…
    expect(
      isResumeTokenValid(env, {
        now: RESUME_NEVER_LOCK_HARD_CAP_MS - 1,
        appVersion: APP_VERSION,
        blobUrl: BLOB,
        autoLockMinutes: 0,
      }),
    ).toBe(true);
    // …just past it is refused, even though auto-lock is "never".
    expect(
      isResumeTokenValid(env, {
        now: RESUME_NEVER_LOCK_HARD_CAP_MS + 1,
        appVersion: APP_VERSION,
        blobUrl: BLOB,
        autoLockMinutes: 0,
      }),
    ).toBe(false);
  });

  it("refreshes the activity stamp without disturbing the wrapped secret", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();
    await saveResumeToken({ passphrase: "p", blobUrl: BLOB, now: 1000, box, storage });
    const before = readResumeEnvelope(storage) as ResumeTokenEnvelope;

    touchResumeActivity(9999, storage);
    const after = readResumeEnvelope(storage) as ResumeTokenEnvelope;
    expect(after.at).toBe(9999);
    expect(after.wrapped).toBe(before.wrapped); // ciphertext untouched
    expect(await unwrapResumePassphrase(after, box)).toBe("p");
  });

  it("simulates a tab close: cleared storage yields no token to resume", async () => {
    const box = await memoryBox();
    const storage = memoryStorage();
    await saveResumeToken({ passphrase: "p", blobUrl: BLOB, now: 1000, box, storage });
    expect(readResumeEnvelope(storage)).not.toBeNull();

    // sessionStorage is wiped on a real tab/window close.
    clearResumeToken(storage);
    expect(readResumeEnvelope(storage)).toBeNull();
    expect(
      isResumeTokenValid(readResumeEnvelope(storage), {
        now: 2000,
        appVersion: APP_VERSION,
        blobUrl: BLOB,
        autoLockMinutes: 5,
      }),
    ).toBe(false);
  });

  it("ignores malformed stored JSON", () => {
    const storage = memoryStorage();
    storage.value = "{not json";
    expect(readResumeEnvelope(storage)).toBeNull();
    storage.value = JSON.stringify({ t: 1, v: APP_VERSION }); // missing fields
    expect(readResumeEnvelope(storage)).toBeNull();
  });
});
