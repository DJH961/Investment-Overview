/**
 * Typed fetch wrapper.
 *
 * - A 401 from any call notifies the auth-lost listeners (they wipe cached
 *   portfolio data) and, unless `skipAuthRedirect`, routes to /login.
 * - A 403 with `detail.code === "reauth_required"` (a sensitive action on a
 *   session that signed in too long ago) asks the user to sign in again via the
 *   re-auth handler (default: /login?next=<current page>).
 */

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** Error code the server sends when an action needs a recent sign-in. */
export const REAUTH_REQUIRED = "reauth_required";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Machine-readable `detail.code`, when the server sent one. */
  readonly code: string | undefined;
  constructor(status: number, message: string, body?: unknown, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/** `{detail: "text"}` or `{detail: {code, message}}` → message and code. */
function readDetail(payload: unknown): { message?: string; code?: string } {
  if (!payload || typeof payload !== "object" || !("detail" in payload)) return {};
  const detail = (payload as { detail: unknown }).detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const { code, message } = detail as { code?: unknown; message?: unknown };
    return {
      code: typeof code === "string" ? code : undefined,
      message: typeof message === "string" ? message : undefined,
    };
  }
  return { message: String(detail) };
}

type AuthLostListener = () => void;
const authLostListeners = new Set<AuthLostListener>();

/** Run `listener` whenever the server answers 401 (session gone). Returns an unsubscribe. */
export function addAuthLostListener(listener: AuthLostListener): () => void {
  authLostListeners.add(listener);
  return () => authLostListeners.delete(listener);
}

function notifyAuthLost(): void {
  for (const listener of authLostListeners) {
    try {
      listener();
    } catch {
      /* one failing listener must not block the others or the redirect */
    }
  }
}

/** Login URL that returns to `path` after signing in again. */
export function reauthLoginPath(path: string): string {
  return `/login?next=${encodeURIComponent(path)}&reauth=1`;
}

type ReauthHandler = () => void;

let onReauthRequired: ReauthHandler = () => {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign(reauthLoginPath(window.location.pathname + window.location.search));
  }
};

/** Override what happens on 403 `reauth_required` (the app installs a client-side redirect). */
export function setReauthHandler(handler: ReauthHandler): void {
  onReauthRequired = handler;
}

type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler = () => {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
};

/** Override the 401 behaviour (the app installs a client-side redirect). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Do not redirect on 401 (login form and the /auth/me probe). */
  skipAuthRedirect?: boolean;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, skipAuthRedirect = false } = options;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  if (res.status === 401) {
    notifyAuthLost();
    if (!skipAuthRedirect) onUnauthorized();
  }
  if (!res.ok) {
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    const { message, code } = readDetail(payload);
    if (res.status === 403 && code === REAUTH_REQUIRED) onReauthRequired();
    throw new ApiError(res.status, message ?? (res.statusText || `HTTP ${res.status}`), payload, code);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
