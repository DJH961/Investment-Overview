import type { QueryClient } from "@tanstack/react-query";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";
import { forgetPasskeyId, lastPasskeyId, markSignedOut, rememberPasskeyDevice, rememberPasskeyId } from "./passkeyHint";
import { clearClientData } from "./queries";

export {
  clearSignedOutFlag,
  forgetPasskeyDevice,
  notePasskeyAutoDeclined,
  rememberPasskeyDevice,
  shouldAutoPromptPasskey,
} from "./passkeyHint";

export interface PasskeyInfo {
  id: string | number;
  name?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
}

export function login(password: string): Promise<void> {
  return api<void>("/api/auth/login", { method: "POST", body: { password }, skipAuthRedirect: true });
}

/** Sign out and wipe cached portfolio data, even when the request fails. */
export async function logout(): Promise<void> {
  try {
    await api<void>("/api/auth/logout", { method: "POST", skipAuthRedirect: true });
  } finally {
    clearClientData();
    markSignedOut();
  }
}

/**
 * Passkey sign-in. With `autofill` the browser's conditional UI is used
 * (resolves only when the user picks a passkey from the autofill list).
 */
export async function passkeyLogin(autofill = false): Promise<void> {
  // Name the passkey this device used last, so the browser skips its picker.
  // Autofill (conditional UI) always lists every passkey instead.
  const named = autofill ? null : lastPasskeyId();
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/auth/passkey/login/options",
    { method: "POST", body: named ? { credential_id: named } : {}, skipAuthRedirect: true },
  );
  let credential: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    credential = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
  } catch (err) {
    if (named) forgetPasskeyId();
    throw err;
  }
  await api<void>("/api/auth/passkey/login/verify", { method: "POST", body: credential, skipAuthRedirect: true });
  rememberPasskeyId(credential.id);
  rememberPasskeyDevice();
}

export async function registerPasskey(name?: string): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/api/auth/passkey/register/options",
    { method: "POST", body: name ? { name } : {} },
  );
  const credential = await startRegistration({ optionsJSON });
  await api<void>("/api/auth/passkey/register/verify", {
    method: "POST",
    body: name ? { ...credential, name } : credential,
  });
  rememberPasskeyId(credential.id);
  rememberPasskeyDevice();
}

export function listPasskeys(): Promise<PasskeyInfo[]> {
  return api<PasskeyInfo[]>("/api/auth/passkeys");
}

export function deletePasskey(id: string | number): Promise<void> {
  return api<void>(`/api/auth/passkeys/${encodeURIComponent(String(id))}`, { method: "DELETE" });
}

/** Only same-app absolute paths are allowed as a post-login target. */
export function safeNext(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.startsWith("/login")) {
    return "/";
  }
  return next;
}

export function invalidateAuth(queryClient: QueryClient): Promise<void> {
  // Drop (not just invalidate) the cached answer: RequireAuth would otherwise
  // read the stale `authenticated: false` and bounce straight back to /login.
  queryClient.removeQueries({ queryKey: ["auth", "me"] });
  return Promise.resolve();
}
