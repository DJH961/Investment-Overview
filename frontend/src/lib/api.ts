/**
 * Typed fetch wrapper.
 *
 * - A 401 from any call notifies the auth-lost listeners (they wipe cached
 *   portfolio data) and, unless `skipAuthRedirect`, routes to /login.
 * - A 403 with `detail.code === "reauth_required"` (a sensitive action on a
 *   session that signed in too long ago) asks the user to sign in again via the
 *   re-auth handler (default: /login?next=<current page>).
 */

import { markReachable, markUnreachable } from "./network";
import { isRidingOutOutage } from "./serverStatus";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** GETs give up after this long, so a bad connection falls back to cached data quickly. */
export const DEFAULT_GET_TIMEOUT_MS = 20_000;

/** Proxy answers that mean "the app itself did not answer" (restart, deploy, crash). */
const UNREACHABLE_STATUSES = new Set([502, 503, 504]);

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

/**
 * The request never got an answer from the server: no network, a dropped
 * connection or a timeout. Nothing is known about whether a write landed.
 */
export class NetworkError extends Error {
  readonly timedOut: boolean;
  constructor(timedOut = false) {
    super(
      timedOut
        ? "The server took too long to answer. Your connection may be slow; please try again."
        : "Can't reach the server. Check your connection and try again.",
    );
    this.name = "NetworkError";
    this.timedOut = timedOut;
  }
}

/** True for errors caused by connectivity rather than by the server's answer. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof ApiError && UNREACHABLE_STATUSES.has(err.status));
}

type AuthLostListener = () => void;
const authLostListeners = new Set<AuthLostListener>();

/** Run `listener` whenever the server answers 401 (session gone). Returns an unsubscribe. */
export function addAuthLostListener(listener: AuthLostListener): () => void {
  authLostListeners.add(listener);
  return () => authLostListeners.delete(listener);
}

/**
 * `/both` GETs: the last ETag and body per URL, so a 304 can answer from memory.
 * The app sends `Cache-Control: no-store`, so the browser never revalidates by itself.
 */
const BOTH_CACHE_MAX = 64;
const bothCache = new Map<string, { etag: string; text: string }>();
const isBothUrl = (path: string) => /\/both(\?|$)/.test(path);

function rememberBoth(path: string, etag: string, text: string): void {
  bothCache.delete(path);
  bothCache.set(path, { etag, text });
  if (bothCache.size > BOTH_CACHE_MAX) bothCache.delete(bothCache.keys().next().value as string);
}

/** Forget remembered `/both` bodies (sign-out, tests). */
export function clearEtagCache(): void {
  bothCache.clear();
}

function notifyAuthLost(): void {
  bothCache.clear();
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
  /**
   * Abort after this many ms and throw a `NetworkError`. Default: 20 s for GET,
   * none for writes (a write may legitimately run long on the server). 0 = none.
   */
  timeoutMs?: number;
  /**
   * GET only. While the server is restarting or lost, retry quietly with backoff
   * instead of failing, so the page keeps its old data. Default true; the health
   * poll turns it off.
   */
  rideOut?: boolean;
  /**
   * Marks a refetch the app started by itself (a live tick), not the user: the server
   * then does not slide the session idle timeout. Set automatically inside
   * `runAsBackgroundRefetch`.
   */
  background?: boolean;
}

let backgroundDepth = 0;

/** Requests started synchronously inside `fn` are background refetches (B-015). */
export function runAsBackgroundRefetch<T>(fn: () => T): T {
  backgroundDepth += 1;
  try {
    return fn();
  } finally {
    backgroundDepth -= 1;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Typed request. A GET that cannot reach the server while a restart is announced
 * (or the stream is lost) keeps retrying with backoff (1 s, 2 s … 5 s) rather than
 * surfacing an error, until it succeeds, the caller cancels or the outage ends.
 */
export async function api<T = unknown>(path: string, inOptions: RequestOptions = {}): Promise<T> {
  // Decided now (synchronously): a ride-out retry later must keep the same header.
  const options: RequestOptions =
    inOptions.background === undefined && backgroundDepth > 0 ? { ...inOptions, background: true } : inOptions;
  if ((options.method ?? "GET") !== "GET" || options.rideOut === false) return request<T>(path, options);
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<T>(path, options);
    } catch (err) {
      if (!isNetworkError(err) || !isRidingOutOutage() || options.signal?.aborted) throw err;
      await sleep(Math.min(5000, 1000 * 2 ** attempt), options.signal);
    }
  }
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const { method = "GET", body, signal, skipAuthRedirect = false } = options;
  const timeoutMs = options.timeoutMs ?? (method === "GET" ? DEFAULT_GET_TIMEOUT_MS : 0);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (options.background && method === "GET") headers["X-Background-Refetch"] = "1";
  const conditional = method === "GET" && isBothUrl(path);
  const remembered = conditional ? bothCache.get(path) : undefined;
  if (remembered) headers["If-None-Match"] = remembered.etag;

  // One controller for both the caller's cancel (TanStack Query) and our timeout.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  // A failure that is not the caller cancelling is a connectivity problem.
  const asNetworkError = (err: unknown): unknown => {
    if (signal?.aborted && !timedOut) return err;
    markUnreachable();
    return new NetworkError(timedOut);
  };

  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch (err) {
      throw asNetworkError(err);
    }
    if (UNREACHABLE_STATUSES.has(res.status)) markUnreachable();
    else markReachable();
    if (res.status === 401) {
      notifyAuthLost();
      if (!skipAuthRedirect) onUnauthorized();
    }
    if (res.status === 304 && remembered) return JSON.parse(remembered.text) as T;
    if (!res.ok) {
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        payload = undefined;
      }
      const { message, code } = readDetail(payload);
      if (res.status === 403 && code === REAUTH_REQUIRED) onReauthRequired();
      const fallback = UNREACHABLE_STATUSES.has(res.status)
        ? "The server is not answering right now (it may be restarting). Please try again shortly."
        : res.statusText || `HTTP ${res.status}`;
      throw new ApiError(res.status, message ?? fallback, payload, code);
    }
    if (res.status === 204) return undefined as T;
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw asNetworkError(err);
    }
    const etag = conditional ? res.headers.get("ETag") : null;
    if (etag && text) rememberBoth(path, etag, text);
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}
