/**
 * Progressive-web-app registration (proposal §6.1).
 *
 * Registers the service worker (`sw.js`, served from the build root) that makes
 * the companion installable and lets its app shell load offline. The worker
 * caches **only** the public, same-origin shell — never the encrypted blob, the
 * live price/FX responses, or any decrypted data (which stays in memory). See
 * `web/public/sw.js` for the security rationale.
 *
 * Registration is a progressive enhancement: a browser without service-worker
 * support, or a registration that fails, simply runs the app online-only. It
 * never throws into the boot path.
 */

/** The slice of `navigator.serviceWorker` this module needs (injectable for tests). */
export interface ServiceWorkerHost {
  register(url: string, options?: { scope?: string }): Promise<unknown>;
}

/**
 * Resolve the platform service-worker container, or `null` when the runtime
 * doesn't support service workers (older browsers, or the Node test env).
 */
export function serviceWorkerHost(
  nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator,
): ServiceWorkerHost | null {
  if (!nav || !("serviceWorker" in nav)) return null;
  return (nav as Navigator & { serviceWorker: ServiceWorkerHost }).serviceWorker;
}

/**
 * Register the service worker. Returns `true` when registration was issued,
 * `false` when unsupported or it failed (in which case the app continues
 * online-only). Never rejects.
 */
export async function registerServiceWorker(
  host: ServiceWorkerHost | null = serviceWorkerHost(),
  swUrl = "./sw.js",
): Promise<boolean> {
  if (!host) return false;
  try {
    await host.register(swUrl, { scope: "./" });
    return true;
  } catch {
    return false;
  }
}
