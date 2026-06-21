/**
 * Tests for the biometric-unlock crypto core: wrapping the passphrase under the
 * PRF-derived key and unwrapping it again. The WebAuthn ceremony itself is
 * browser-only, but the AES-GCM wrap/unwrap is pure WebCrypto and testable.
 */
import { describe, expect, it } from "vitest";

import { unwrapPassphrase, wrapPassphrase } from "../src/webauthn";

/** A stand-in for a 32-byte WebAuthn PRF output. */
function prfSecret(seed: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed + i) & 0xff;
  return bytes.buffer;
}

describe("biometric passphrase wrap/unwrap", () => {
  it("round-trips a passphrase under the same PRF secret", async () => {
    const secret = prfSecret(1);
    const { iv, ciphertext } = await wrapPassphrase("correct horse battery staple", secret);
    const out = await unwrapPassphrase(ciphertext, iv, prfSecret(1));
    expect(out).toBe("correct horse battery staple");
  });

  it("fails to unwrap with a different PRF secret", async () => {
    const { iv, ciphertext } = await wrapPassphrase("hunter2", prfSecret(2));
    await expect(unwrapPassphrase(ciphertext, iv, prfSecret(99))).rejects.toThrow();
  });

  it("produces a fresh nonce each time (no ciphertext reuse)", async () => {
    const secret = prfSecret(3);
    const a = await wrapPassphrase("same", secret);
    const b = await wrapPassphrase("same", secret);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
