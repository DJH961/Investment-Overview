/*
 * Service worker: caches the same-origin app shell only. /api/* (including the
 * SSE stream) is never cached or intercepted; offline data comes from the
 * TanStack Query persistence layer.
 *
 * Page loads (reload, opening a link) try the network first but wait at most
 * NAVIGATE_TIMEOUT_MS before answering from the cached shell, so a bad
 * connection still opens the app quickly. The slow network answer, if it
 * arrives, refreshes the cache for the next load. A 5xx from the proxy (app
 * restarting during a deploy) also falls back to the cached shell.
 */
const CACHE = "iv-shell-v2";
const NAVIGATE_TIMEOUT_MS = 3000;
const ASSET_RE = /(?:src|href)="(\/[^"]+\.(?:js|css|svg|png|ico|webmanifest))"/g;

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline · Investment Overview</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;background:#0b0e14;color:#eef2f8;text-align:center;padding:16px}p{color:#9aa6b8}</style>
</head><body><main><h1>You're offline</h1><p>Investment Overview could not be loaded. Reconnect and reload the page.</p></main></body></html>`;

function assetsIn(html) {
  return [...html.matchAll(ASSET_RE)].map((m) => m[1]);
}

/** Store a fresh index.html; drop hashed build files the new build no longer uses. */
async function storeShell(res) {
  const cache = await caches.open(CACHE);
  const html = await res.clone().text();
  await cache.put("/index.html", res.clone());
  await cache.put("/", res);
  const wanted = new Set(assetsIn(html));
  await Promise.allSettled([...wanted].map(async (url) => (await cache.match(url)) || cache.add(url)));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && /\.(?:js|css)$/.test(path) && !wanted.has(path)) await cache.delete(req);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/", { cache: "reload" });
        if (res.ok) await storeShell(res);
      } catch {
        /* offline at install: runtime caching fills in later */
      }
      await self.skipWaiting();
    })(),
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

function navigate(event) {
  const network = fetch(event.request).then((res) => {
    if (res.ok && res.type === "basic") event.waitUntil(storeShell(res.clone()).catch(() => undefined));
    return res;
  });
  // Keep the SW alive until the slow answer lands, so it can refresh the cache.
  event.waitUntil(network.then(() => undefined, () => undefined));

  return (async () => {
    const cached = await caches.match("/index.html");
    if (!cached) {
      try {
        return await network;
      } catch {
        return new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), NAVIGATE_TIMEOUT_MS);
    });
    try {
      const res = await Promise.race([network, timeout]);
      // Timed out, or the proxy answered for an app that is down: the cached shell works.
      if (!res || res.status >= 500) return cached;
      return res;
    } catch {
      return cached;
    } finally {
      clearTimeout(timer);
    }
  })();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(navigate(event));
    return;
  }

  // Hashed build assets are immutable: cache-first, fill on miss.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
          }
          return res;
        }),
    ),
  );
});
