/*
 * Passkey auto-prompt. The browser can't tell a page whether this device holds
 * one of its passkeys (that would let sites fingerprint users), so the app
 * remembers it: a passkey sign-in or registration on this device sets a hint,
 * and the login page then opens the passkey dialog by itself. Two dismissals in
 * a row turn the auto-prompt off until the next passkey sign-in; signing out on
 * purpose skips it for that tab, so you are not asked straight back in.
 */
const PASSKEY_HINT_KEY = "iv.passkey.device";
const PASSKEY_DECLINES_KEY = "iv.passkey.declines";
const SIGNED_OUT_KEY = "iv.signed-out";
const MAX_DECLINES = 2;

function readStore(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function writeStore(store: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    /* storage unavailable: the auto-prompt just stays off */
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

/** This device has used a passkey here: offer it automatically next time. */
export function rememberPasskeyDevice(): void {
  writeStore(local, PASSKEY_HINT_KEY, "1");
  writeStore(local, PASSKEY_DECLINES_KEY, null);
}

/** No passkeys are registered any more: stop auto-prompting. */
export function forgetPasskeyDevice(): void {
  writeStore(local, PASSKEY_HINT_KEY, null);
  writeStore(local, PASSKEY_DECLINES_KEY, null);
}

/** The user dismissed an automatic passkey prompt. */
export function notePasskeyAutoDeclined(): void {
  const n = Number(readStore(local, PASSKEY_DECLINES_KEY) ?? "0") || 0;
  writeStore(local, PASSKEY_DECLINES_KEY, String(n + 1));
}

/** The user signed out on purpose (this tab skips the auto-prompt). */
export function markSignedOut(): void {
  writeStore(session, SIGNED_OUT_KEY, "1");
}

/** A sign-in finished: a later sign-out may skip the auto-prompt again. */
export function clearSignedOutFlag(): void {
  writeStore(session, SIGNED_OUT_KEY, null);
}

/** Should the login page open the passkey dialog without a click? */
export function shouldAutoPromptPasskey(): boolean {
  if (readStore(local, PASSKEY_HINT_KEY) !== "1") return false;
  if ((Number(readStore(local, PASSKEY_DECLINES_KEY) ?? "0") || 0) >= MAX_DECLINES) return false;
  if (readStore(session, SIGNED_OUT_KEY) === "1") return false;
  return typeof navigator === "undefined" || navigator.onLine !== false;
}
