/**
 * WebCrypto decryption for the published `portfolio.enc` envelope.
 *
 * Mirrors `investment_dashboard/storage/blob_crypto.py` exactly:
 *   - KDF: PBKDF2-HMAC-SHA256, the envelope's iteration count, 256-bit key,
 *   - cipher: AES-256-GCM with a 128-bit tag,
 *   - the Python side stores `ciphertext` and `tag` separately, so we recombine
 *     them into `ciphertext || tag`, which is the buffer SubtleCrypto expects.
 *
 * Everything runs in the browser against `crypto.subtle`; no JavaScript crypto
 * dependency is bundled. Decrypted plaintext exists only in memory.
 */

export const KDF_NAME = "PBKDF2-HMAC-SHA256";
export const ENVELOPE_VERSION = 1;

export interface Envelope {
  v: number;
  kdf: string;
  kdf_params: { salt: string; iterations: number };
  nonce: string;
  ciphertext: string;
  tag: string;
}

export class DecryptError extends Error {}

function base64ToBytes(value: string, field: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new DecryptError(`envelope field ${field} is not valid base64`);
  }
}

/** Validate the shape of a parsed envelope, throwing `DecryptError` on problems. */
export function assertEnvelope(value: unknown): asserts value is Envelope {
  if (typeof value !== "object" || value === null) {
    throw new DecryptError("envelope must be a JSON object");
  }
  const env = value as Record<string, unknown>;
  if (env.v !== ENVELOPE_VERSION) {
    throw new DecryptError(`unsupported envelope version: ${String(env.v)}`);
  }
  if (env.kdf !== KDF_NAME) {
    throw new DecryptError(`unsupported KDF: ${String(env.kdf)}`);
  }
  const params = env.kdf_params;
  if (typeof params !== "object" || params === null) {
    throw new DecryptError("envelope is missing kdf_params");
  }
  const iterations = (params as Record<string, unknown>).iterations;
  if (typeof iterations !== "number" || !Number.isInteger(iterations) || iterations <= 0) {
    throw new DecryptError("envelope has an invalid iteration count");
  }
  for (const field of ["nonce", "ciphertext", "tag"] as const) {
    if (typeof env[field] !== "string") {
      throw new DecryptError(`envelope is missing ${field}`);
    }
  }
  if (typeof (params as Record<string, unknown>).salt !== "string") {
    throw new DecryptError("envelope is missing kdf_params.salt");
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

/** Decrypt an envelope to raw plaintext bytes. Throws `DecryptError` on failure. */
export async function decryptEnvelope(envelope: Envelope, passphrase: string): Promise<Uint8Array> {
  assertEnvelope(envelope);
  if (!passphrase) throw new DecryptError("a passphrase is required to decrypt");

  const salt = base64ToBytes(envelope.kdf_params.salt, "kdf_params.salt");
  const nonce = base64ToBytes(envelope.nonce, "nonce");
  const ciphertext = base64ToBytes(envelope.ciphertext, "ciphertext");
  const tag = base64ToBytes(envelope.tag, "tag");

  // SubtleCrypto's AES-GCM expects ciphertext || tag in one buffer.
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  const key = await deriveKey(passphrase, salt, envelope.kdf_params.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as unknown as BufferSource, tagLength: 128 },
      key,
      combined as unknown as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new DecryptError("decryption failed — wrong passphrase or the blob was tampered with");
  }
}

/** Decrypt an envelope and parse the plaintext as JSON. */
export async function decryptEnvelopeToJson<T>(envelope: Envelope, passphrase: string): Promise<T> {
  const bytes = await decryptEnvelope(envelope, passphrase);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
