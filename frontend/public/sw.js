/*
 * Service worker: caches the same-origin app shell only. /api/* (including the
 * SSE stream) is never cached or intercepted; offline data comes from the
 * TanStack Query persistence layer.
 */
const CACHE = "iv-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch("/", { cache: "reload" });
        if (res.ok) {
          const html = await res.clone().text();
          await cache.put("/index.html", res.clone());
          await cache.put("/", res);
          const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|svg|webmanifest))"/g)].map((m) => m[1]);
          await Promise.allSettled(assets.map((url) => cache.add(url)));
        }
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put("/index.html", res.clone()));
          return res;
        })
        .catch(async () => (await caches.match("/index.html")) || Response.error()),
    );
    return;
  }

  // Hashed build assets are immutable: cache-first, fill on miss.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        }),
    ),
  );
});
