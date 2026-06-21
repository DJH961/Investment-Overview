/**
 * CORS proxy for the live-web companion's encrypted blob (Cloudflare Worker).
 *
 * Why this exists
 * ---------------
 * The desktop app publishes the AES-256-GCM `portfolio.enc` envelope as a single
 * GitHub *release asset* that it overwrites on every publish. Release assets are
 * ideal for git-history hygiene (old ciphertext never accumulates in the tree),
 * but GitHub's `releases/download/...` endpoint 302-redirects to
 * `release-assets.githubusercontent.com`, which serves NO
 * `Access-Control-Allow-Origin` header. A browser on the GitHub Pages origin is
 * therefore blocked from `fetch()`-ing it cross-origin ("Failed to fetch").
 *
 * This Worker sits in front of that one release asset: it fetches the asset
 * server-side (where CORS does not apply, and the GitHub redirect is followed
 * transparently) and re-emits the bytes with permissive CORS headers so the
 * browser companion can read them.
 *
 * Security
 * --------
 * - The Worker only ever touches OPAQUE CIPHERTEXT. It cannot decrypt anything;
 *   the passphrase never leaves the user's browser. So a public, unauthenticated
 *   proxy here leaks nothing the release asset doesn't already expose publicly.
 * - It is NOT an open proxy: the upstream URL is fixed to a single release asset
 *   (configured via the `RELEASE_URL` var in wrangler.toml), so it can't be
 *   abused to fetch arbitrary targets (no SSRF).
 *
 * Deploy: see web/proxy/README.md.
 */

/** Default upstream — overridden by the `RELEASE_URL` var in wrangler.toml. */
const DEFAULT_RELEASE_URL =
  "https://github.com/DJH961/Investment-Overview/releases/download/live-data/portfolio.enc";

/**
 * Derive the version-sidecar URL (`portfolio.meta.json`) from the blob URL by
 * swapping the filename. Overridable via the `META_URL` var in wrangler.toml for
 * setups where the sidecar lives elsewhere.
 */
function defaultMetaUrl(releaseUrl) {
  return releaseUrl.replace(/portfolio\.enc(\?|$)/, "portfolio.meta.json$1");
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "If-None-Match, If-Modified-Since, *",
    // Let the browser READ the validators it needs for conditional requests.
    "Access-Control-Expose-Headers": "ETag, Last-Modified",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  /**
   * @param {Request} request
   * @param {{ RELEASE_URL?: string, META_URL?: string }} env
   */
  async fetch(request, env) {
    const releaseUrl = env.RELEASE_URL || DEFAULT_RELEASE_URL;
    const cors = corsHeaders();

    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    // Read-only proxy: only GET/HEAD are meaningful for a static blob.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...cors, Allow: "GET, HEAD, OPTIONS" },
      });
    }

    // A `?meta` flag serves the tiny version sidecar (portfolio.meta.json)
    // instead of the blob, so the companion can ask "is there a newer export?"
    // for a few bytes. Both targets are pinned (no SSRF: still not an open proxy).
    const wantsMeta = new URL(request.url).searchParams.has("meta");
    const upstreamUrl = wantsMeta ? (env.META_URL || defaultMetaUrl(releaseUrl)) : releaseUrl;
    const contentType = wantsMeta ? "application/json" : "application/octet-stream";

    // Forward the conditional-request validators so GitHub can answer 304 and we
    // can relay it straight back — no body transferred when nothing changed.
    const upstreamHeaders = { Accept: contentType };
    const ifNoneMatch = request.headers.get("If-None-Match");
    const ifModifiedSince = request.headers.get("If-Modified-Since");
    if (ifNoneMatch) upstreamHeaders["If-None-Match"] = ifNoneMatch;
    if (ifModifiedSince) upstreamHeaders["If-Modified-Since"] = ifModifiedSince;

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method,
        redirect: "follow", // follow GitHub -> release-assets redirect server-side
        headers: upstreamHeaders,
        // Never cache: the asset is overwritten frequently and must stay fresh.
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (err) {
      return new Response(`upstream fetch failed: ${err}`, {
        status: 502,
        headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const headers = new Headers(cors);
    headers.set("Content-Type", contentType);
    // The blob changes often; do not let the browser or any CDN serve a stale copy.
    headers.set("Cache-Control", "no-store");
    // Pass through the validators so the browser can cache them for next time.
    const etag = upstream.headers.get("ETag");
    const lastModified = upstream.headers.get("Last-Modified");
    if (etag) headers.set("ETag", etag);
    if (lastModified) headers.set("Last-Modified", lastModified);

    // 304 Not Modified: relay it bodyless — the whole point of the conditional GET.
    if (upstream.status === 304) {
      return new Response(null, { status: 304, headers });
    }

    const length = upstream.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
