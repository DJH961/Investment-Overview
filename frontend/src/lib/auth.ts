import type { QueryClient } from "@tanstack/react-query";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

export interface PasskeyInfo {
  id: string | number;
  name?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
}

export function login(password: string): Promise<void> {
  return api<void>("/api/auth/login", { method: "POST", body: { password }, skipAuthRedirect: true });
}

export function logout(): Promise<void> {
  return api<void>("/api/auth/logout", { method: "POST", skipAuthRedirect: true });
}

/**
 * Passkey sign-in. With `autofill` the browser's conditional UI is used
 * (resolves only when the user picks a passkey from the autofill list).
 */
export async function passkeyLogin(autofill = false): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/auth/passkey/login/options",
    { method: "POST", skipAuthRedirect: true },
  );
  const credential = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
  await api<void>("/api/auth/passkey/login/verify", { method: "POST", body: credential, skipAuthRedirect: true });
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
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return "/";
  return next;
}

export function invalidateAuth(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
}
