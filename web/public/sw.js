/*
 * Service worker for the v3.0 Live Web Companion (proposal §6.1).
 *
 * SECURITY — this repository is PUBLIC. This worker caches ONLY the static,
 * same-origin app shell (HTML / JS / CSS / fonts / icons) so the UI opens
 * instantly and the chrome works offline. It deliberately NEVER caches:
 *   - the encrypted portfolio blob (a cross-origin GitHub release asset),
 *   - live price / FX API responses (cross-origin), or
 *   - any decrypted portfolio data — that never touches the network or disk,
 *     it lives in memory only and is never persisted.
 *
 * The guarantee is structural, not incidental: cross-origin requests return
 * early (network-only), so the only things that can ever enter Cache Storage
 * are public, same-origin shell assets.
 */

const CACHE = "iz-shell-v1";

// Minimal install-time precache. Hashed build assets are picked up lazily by
// the runtime network-first handler below, so this list stays tiny and never
// needs regenerating when filenames change.
const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is atomic; if any entry 404s the whole install fails, so keep it
      // to entries we know the build emits. Individual misses are tolerated via
      // Promise.allSettled to avoid wedging activation on a transient gap.
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Hard boundary: only the same-origin shell is ever cached. The encrypted
  // blob and the price/FX APIs are cross-origin and stay network-only, so no
  // portfolio-derived bytes can land in Cache Storage.
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    // Only store successful, same-origin ("basic") responses.
    if (fresh && fresh.ok && fresh.type === "basic") {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = (await cache.match(req)) || (await cache.match("./index.html"));
    if (cached) return cached;
    throw err;
  }
}
