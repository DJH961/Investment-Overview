/**
 * Stale-tab guard. An open tab keeps running the JavaScript it loaded, so after a
 * deploy it would keep calling routes of the old version until a full reload.
 * Whenever the live stream (re)connects, `live.ts` reports the server's version
 * here; if it differs from this build's version, the page reloads itself at a
 * safe moment: right away while the tab is hidden, otherwise the next time the
 * tab is hidden or shown again, and never while the user is typing or has a
 * dialog open. Each server version triggers at most one reload per tab session,
 * so a mismatch that a reload cannot fix never loops.
 */

declare const __APP_VERSION__: string;

/** This build's version (from `frontend/package.json`, injected by Vite). */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

const RELOADED_KEY = "iv-reloaded-for";

let pending: string | null = null;
let listening = false;
let reloadFn: () => void = () => window.location.reload();

/** Tests swap the reload for a spy. */
export function setReloadForTests(fn: (() => void) | null): void {
  reloadFn = fn ?? (() => window.location.reload());
  pending = null;
}

function busy(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLElement) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  }
  return document.querySelector('[role="dialog"], dialog[open]') !== null;
}

function alreadyReloadedFor(version: string): boolean {
  try {
    return sessionStorage.getItem(RELOADED_KEY) === version;
  } catch {
    return false;
  }
}

function tryReload(): void {
  if (!pending || busy()) return;
  const version = pending;
  pending = null;
  try {
    sessionStorage.setItem(RELOADED_KEY, version);
  } catch {
    /* no storage: still reload once (pending is cleared) */
  }
  reloadFn();
}

function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", tryReload);
}

/**
 * The server says it runs `serverVersion`. Returns true when a reload is now
 * scheduled (or done) because this tab runs an older build.
 */
export function noteServerVersion(serverVersion: string | null | undefined, ownVersion: string = APP_VERSION): boolean {
  if (!serverVersion || !ownVersion || serverVersion === ownVersion) return false;
  if (alreadyReloadedFor(serverVersion)) return false;
  pending = serverVersion;
  listen();
  if (document.hidden) tryReload();
  return true;
}
