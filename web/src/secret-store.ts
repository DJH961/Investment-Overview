/**
 * At-rest encryption for the single device-local secret: the Twelve Data API key.
 *
 * The token is encrypted with a per-device AES-GCM `CryptoKey` that is generated
 * once and kept in IndexedDB as a NON-EXTRACTABLE key. `localStorage` therefore
 * only ever holds ciphertext + IV — never the plaintext token — and the wrapping
 * key itself cannot be read back out of the browser, even by script. This keeps
 * the "enter the key once per device" UX (proposal §6.2) while ensuring a passive
 * `localStorage` dump (an accidental log/serialization leak, a backup export, …)
 * does not reveal the token.
 *
 * Everything runs against `crypto.subtle`; no JavaScript crypto is bundled.
 */

const DB_NAME = "iv.web.keystore";
const STORE_NAME = "keys";
const KEY_ID = "apiKey";
/** Version tag prefixing every stored ciphertext, so the format can evolve. */
export const SECRET_PREFIX = "v1";

/** Source of the (non-extractable) AES-GCM key used to wrap the secret. */
export interface KeyProvider {
  getKey(): Promise<CryptoKey>;
}

/** Reversible at-rest protection for a single string secret. */
export interface SecretBox {
  encrypt(plain: string): Promise<string>;
  decrypt(stored: string): Promise<string>;
}

/** True when `value` is one of our versioned ciphertexts (not legacy plaintext). */
export function looksEncrypted(value: string): boolean {
  return value.startsWith(`${SECRET_PREFIX}.`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function idbRequest<T>(makeRequest: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode) {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = makeRequest(tx.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

/**
 * Default key provider: a non-extractable AES-GCM key persisted in IndexedDB,
 * created on first use and reused thereafter. The in-flight promise is memoised
 * so concurrent callers share a single key (and a single creation).
 */
export function indexedDbKeyProvider(): KeyProvider {
  let cached: Promise<CryptoKey> | null = null;
  const resolveKey = async (): Promise<CryptoKey> => {
    const existing = await idbRequest<CryptoKey | undefined>((store) => store.get(KEY_ID), "readonly");
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbRequest((store) => store.put(key, KEY_ID), "readwrite");
    return key;
  };
  return {
    getKey() {
      if (!cached) {
        cached = resolveKey().catch((err) => {
          cached = null; // allow a later retry (e.g. transient IndexedDB failure)
          throw err;
        });
      }
      return cached;
    },
  };
}

/**
 * Build a `SecretBox`. Defaults to the IndexedDB-backed key provider; tests can
 * inject an in-memory provider so they need no IndexedDB.
 */
export function createSecretBox(provider: KeyProvider = indexedDbKeyProvider()): SecretBox {
  return {
    async encrypt(plain: string): Promise<string> {
      const key = await provider.getKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource },
        key,
        new TextEncoder().encode(plain) as unknown as BufferSource,
      );
      return `${SECRET_PREFIX}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
    },
    async decrypt(stored: string): Promise<string> {
      const parts = stored.split(".");
      if (parts.length !== 3 || parts[0] !== SECRET_PREFIX) {
        throw new Error("secret is not in the expected encrypted format");
      }
      const key = await provider.getKey();
      const iv = base64ToBytes(parts[1]);
      const ciphertext = base64ToBytes(parts[2]);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource },
        key,
        ciphertext as unknown as BufferSource,
      );
      return new TextDecoder().decode(plaintext);
    },
  };
}
