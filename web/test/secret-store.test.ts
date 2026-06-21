/**
 * Secret-store round-trip: the API key must survive encrypt → decrypt, persist
 * only as opaque ciphertext, and reject tampered or malformed input.
 *
 * Uses an in-memory `KeyProvider` (a single non-extractable AES-GCM key) so no
 * IndexedDB is required under the Node test environment; `crypto.subtle` is the
 * same primitive the IndexedDB-backed provider uses in the browser.
 */
import { describe, expect, it } from "vitest";

import { createSecretBox, looksEncrypted, type KeyProvider } from "../src/secret-store";

async function memoryKeyProvider(): Promise<KeyProvider> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { getKey: () => Promise.resolve(key) };
}

describe("secret-store", () => {
  it("round-trips a secret through encrypt/decrypt", async () => {
    const box = createSecretBox(await memoryKeyProvider());
    const secret = "td_live_abc123-XYZ";

    const stored = await box.encrypt(secret);
    expect(await box.decrypt(stored)).toBe(secret);
  });

  it("never stores the plaintext token", async () => {
    const box = createSecretBox(await memoryKeyProvider());
    const secret = "super-secret-token";

    const stored = await box.encrypt(secret);
    expect(stored).not.toContain(secret);
    expect(looksEncrypted(stored)).toBe(true);
  });

  it("produces a fresh IV (different ciphertext) for the same input", async () => {
    const box = createSecretBox(await memoryKeyProvider());

    const a = await box.encrypt("same");
    const b = await box.encrypt("same");
    expect(a).not.toBe(b);
    expect(await box.decrypt(a)).toBe("same");
    expect(await box.decrypt(b)).toBe("same");
  });

  it("rejects malformed or legacy-plaintext values", async () => {
    const box = createSecretBox(await memoryKeyProvider());

    expect(looksEncrypted("plain-legacy-key")).toBe(false);
    await expect(box.decrypt("plain-legacy-key")).rejects.toThrow();
    await expect(box.decrypt("v1.only-two")).rejects.toThrow();
  });

  it("fails to decrypt a tampered ciphertext", async () => {
    const box = createSecretBox(await memoryKeyProvider());
    const stored = await box.encrypt("token");

    const parts = stored.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`;
    await expect(box.decrypt(flipped)).rejects.toThrow();
  });

  it("cannot decrypt with a different device key", async () => {
    const stored = await createSecretBox(await memoryKeyProvider()).encrypt("token");
    const other = createSecretBox(await memoryKeyProvider());
    await expect(other.decrypt(stored)).rejects.toThrow();
  });
});
