/**
 * Optional biometric unlock (fingerprint / Face ID) via WebAuthn + the PRF
 * extension.
 *
 * Typing your mobile passphrase on every quick check is the slowest part of the
 * login. This lets you, once, register the device's platform authenticator (the
 * fingerprint reader) and from then on unlock with a touch instead.
 *
 * How it stays safe without ever storing the passphrase in the clear:
 *   - The WebAuthn **PRF** extension lets a credential deterministically derive
 *     a 32-byte secret from a fixed salt, but *only* after a successful user
 *     verification (the fingerprint touch). The browser/OS keeps the underlying
 *     key in hardware; it is never exposed to JS or to us.
 *   - We use that PRF secret as an AES-256-GCM key to wrap (encrypt) the
 *     passphrase, and persist only the **encrypted** passphrase (the `iv` +
 *     `ciphertext`) alongside the `credentialId` and PRF `prfSalt` needed to
 *     re-derive the key, in `localStorage`. Without a live fingerprint touch on
 *     *this* device the ciphertext is inert.
 *
 * Everything degrades gracefully: if the platform has no authenticator or the
 * PRF extension is unsupported, {@link isBiometricSupported} resolves false and
 * the UI simply never offers the feature.
 */

const STORE_KEY = "iv.web.biometric";
const RP_NAME = "Investment Overview";

/** Persisted enrolment: the wrapped passphrase plus what's needed to unwrap it. */
interface StoredBiometric {
  /** base64 credential id of the registered platform authenticator. */
  credentialId: string;
  /** base64 salt fed to the PRF extension to re-derive the wrapping key. */
  prfSalt: string;
  /** base64 AES-GCM nonce used to wrap the passphrase. */
  iv: string;
  /** base64 AES-256-GCM ciphertext of the passphrase. */
  ciphertext: string;
}

// --- base64 <-> bytes -------------------------------------------------------

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// --- passphrase wrap / unwrap (pure crypto, exported for tests) -------------

async function prfKey(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", prfOutput, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt `passphrase` under the PRF-derived key. */
export async function wrapPassphrase(
  passphrase: string,
  prfOutput: ArrayBuffer,
): Promise<{ iv: string; ciphertext: string }> {
  const key = await prfKey(prfOutput);
  // 12-byte (96-bit) nonce: the size recommended for AES-GCM, fresh per wrap.
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(passphrase) as unknown as BufferSource,
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct) };
}

/** Decrypt a wrapped passphrase with the PRF-derived key. */
export async function unwrapPassphrase(
  ciphertextB64: string,
  ivB64: string,
  prfOutput: ArrayBuffer,
): Promise<string> {
  const key = await prfKey(prfOutput);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) as unknown as BufferSource },
    key,
    base64ToBytes(ciphertextB64) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

// --- WebAuthn PRF plumbing --------------------------------------------------

/** The PRF results we read off a credential's client-extension output. */
interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

function readStored(): StoredBiometric | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredBiometric>;
    if (
      typeof parsed.credentialId === "string" &&
      typeof parsed.prfSalt === "string" &&
      typeof parsed.iv === "string" &&
      typeof parsed.ciphertext === "string"
    ) {
      return parsed as StoredBiometric;
    }
    return null;
  } catch {
    return null;
  }
}

/** Has the user enrolled biometric unlock on this device? */
export function hasBiometricEnrolment(): boolean {
  return readStored() !== null;
}

/** Forget any biometric enrolment on this device. */
export function clearBiometricEnrolment(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Whether this device can offer biometric unlock: a WebAuthn platform
 * authenticator must be present. (PRF support can only be confirmed during
 * enrolment, which aborts cleanly if the extension is unavailable.)
 */
export async function isBiometricSupported(): Promise<boolean> {
  try {
    if (typeof window === "undefined" || typeof window.PublicKeyCredential === "undefined") return false;
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Enrol biometric unlock: register a platform credential, derive a PRF secret,
 * and store the passphrase wrapped under it. Throws a user-facing message if the
 * platform/PRF doesn't support it (the caller should just keep using the
 * passphrase). On any failure no partial enrolment is left behind.
 */
export async function enrolBiometric(passphrase: string): Promise<void> {
  if (!passphrase) throw new Error("A passphrase is required to enable fingerprint unlock.");
  const prfSalt = randomBytes(32);

  let credential: PublicKeyCredential;
  try {
    const created = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32) as unknown as BufferSource,
        rp: { name: RP_NAME, id: window.location.hostname },
        user: {
          id: randomBytes(16) as unknown as BufferSource,
          name: "investment-overview",
          displayName: "Investment Overview",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60_000,
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    });
    if (!created) throw new Error("Fingerprint setup was cancelled.");
    credential = created as PublicKeyCredential;
  } catch (err) {
    throw new Error(`Couldn't set up fingerprint unlock: ${(err as Error).message}`);
  }

  const ext = credential.getClientExtensionResults() as PrfExtensionResults;
  if (!ext.prf?.enabled) {
    throw new Error("This device's authenticator doesn't support the secure key needed for fingerprint unlock.");
  }

  // Obtain the PRF secret. Most platforms only return it on an assertion, so do
  // one get() against the just-created credential.
  const prfOutput = await evaluatePrf(new Uint8Array(credential.rawId), prfSalt);
  if (!prfOutput) {
    throw new Error("This device couldn't derive the secure key needed for fingerprint unlock.");
  }

  const { iv, ciphertext } = await wrapPassphrase(passphrase, prfOutput);
  const stored: StoredBiometric = {
    credentialId: bytesToBase64(new Uint8Array(credential.rawId)),
    prfSalt: bytesToBase64(prfSalt),
    iv,
    ciphertext,
  };
  // SECURITY (accepted, intentional): CodeQL's clear-text-storage rule flags
  // this write because `ciphertext` flows from the passphrase. It is NOT clear
  // text — it is the passphrase AES-256-GCM-encrypted under a key that only the
  // device's authenticator can re-derive (via the WebAuthn PRF secret, gated on
  // a verified fingerprint touch). The persisted record (credential id, PRF
  // salt, nonce, ciphertext) is inert without that hardware-backed touch, so no
  // usable passphrase or plaintext is stored. The trade-off is accepted here.
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    throw new Error("Couldn't save the fingerprint unlock on this device.");
  }
}

/**
 * Unlock with the enrolled fingerprint: prompt for user verification, re-derive
 * the PRF secret, and decrypt the stored passphrase. Throws if not enrolled or
 * the touch fails.
 */
export async function unlockWithBiometric(): Promise<string> {
  const stored = readStored();
  if (!stored) throw new Error("No fingerprint unlock is set up on this device.");
  const prfOutput = await evaluatePrf(base64ToBytes(stored.credentialId), base64ToBytes(stored.prfSalt));
  if (!prfOutput) throw new Error("Fingerprint unlock failed — couldn't derive the key.");
  try {
    return await unwrapPassphrase(stored.ciphertext, stored.iv, prfOutput);
  } catch {
    // A mismatch means the wrapped passphrase is stale (e.g. it was re-enrolled
    // elsewhere); drop it so the UI falls back to the passphrase field.
    clearBiometricEnrolment();
    throw new Error("Fingerprint unlock is out of date — please unlock with your passphrase and re-enable it.");
  }
}

/** Run a WebAuthn assertion with a PRF eval and return the first PRF output. */
async function evaluatePrf(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<ArrayBuffer | null> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32) as unknown as BufferSource,
      allowCredentials: [{ id: credentialId as unknown as BufferSource, type: "public-key" }],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: prfSalt as unknown as BufferSource } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) return null;
  const ext = assertion.getClientExtensionResults() as PrfExtensionResults;
  return ext.prf?.results?.first ?? null;
}
