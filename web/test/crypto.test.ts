/**
 * Crypto parity: the browser WebCrypto path must decrypt an envelope produced
 * by the Python `storage/blob_crypto.encrypt_bytes`.
 *
 * `test/fixtures/golden_envelope.json` is a committed, real envelope (600k
 * PBKDF2 iterations, AES-256-GCM) generated from the Python source. This test
 * proves the two implementations interoperate and that authentication failures
 * (wrong passphrase / tampering) are surfaced.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DecryptError, decryptEnvelope, decryptEnvelopeToJson, type Envelope } from "../src/crypto";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/golden_envelope.json", import.meta.url));

interface Fixture {
  passphrase: string;
  expected_plaintext: string;
  envelope: Envelope;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;

describe("decryptEnvelope", () => {
  it("recovers the Python-produced plaintext with the right passphrase", async () => {
    const bytes = await decryptEnvelope(fixture.envelope, fixture.passphrase);
    expect(new TextDecoder().decode(bytes)).toBe(fixture.expected_plaintext);
  });

  it("parses the decrypted plaintext as JSON", async () => {
    const data = await decryptEnvelopeToJson<{ meta: { schema_version: number } }>(
      fixture.envelope,
      fixture.passphrase,
    );
    expect(data.meta.schema_version).toBe(1);
  });

  it("rejects a wrong passphrase", async () => {
    await expect(decryptEnvelope(fixture.envelope, "not-the-passphrase")).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("rejects a tampered ciphertext", async () => {
    const tampered: Envelope = {
      ...fixture.envelope,
      ciphertext: `${fixture.envelope.ciphertext.slice(0, -4)}AAAA`,
    };
    await expect(decryptEnvelope(tampered, fixture.passphrase)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects an unsupported envelope version", async () => {
    const bad = { ...fixture.envelope, v: 999 } as Envelope;
    await expect(decryptEnvelope(bad, fixture.passphrase)).rejects.toBeInstanceOf(DecryptError);
  });
});
