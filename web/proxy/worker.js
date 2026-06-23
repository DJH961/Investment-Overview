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
 * Tiingo price fallback (`/price` route)
 * --------------------------------------
 * A second, equally-pinned route lives at `…/price`. It proxies **only**
 * `api.tiingo.com` — the IEX quote endpoint (`/iex/?tickers=…`), the daily
 * close endpoint (`/tiingo/daily/<ticker>/prices`), the live FX top-of-book
 * endpoint (`/tiingo/fx/top?tickers=<pair>`, e.g. `eurusd`), and the intraday
 * bars endpoint (`/iex/<ticker>/prices?resampleFreq=1hour`, one ticker per
 * request → the web companion's 1D curve) — injecting the
 * `TIINGO_TOKEN` secret server-side so the browser companion stays
 * Tiingo-keyless. The FX route backs up the home-currency EUR/USD rate the same
 * way the IEX route backs up instrument prices. Symbols/pairs are
 * validated against a strict charset (still no SSRF: the upstream host and paths
 * are fixed; only the ticker list and a few numeric/date query params vary).
 * The token is sent as an `Authorization: Token …` header, never in the URL, so
 * it never lands in a log or a referrer. See web/proxy/README.md to deploy and
 * `wrangler secret put TIINGO_TOKEN`.
 *
 * Deploy: see web/proxy/README.md.
 */

/** Default upstream — overridden by the `RELEASE_URL` var in wrangler.toml. */
const DEFAULT_RELEASE_URL =
  "https://github.com/DJH961/Investment-Overview/releases/download/live-data/portfolio.enc";

/** Tiingo API root — the only upstream the `/price` route is ever allowed to hit. */
const TIINGO_ROOT = "https://api.tiingo.com";
/**
 * Allowed ticker charset. Tiingo US tickers are letters, digits, dot and dash;
 * a comma separates a batch. Anything else is rejected, so the ticker list can
 * never smuggle a path/host into the pinned upstream (no SSRF).
 */
const TICKER_RE = /^[A-Za-z0-9.\-]+$/;
/**
 * Allowed FX pair charset. Tiingo quotes lowercase concatenated ISO pairs
 * (`eurusd`, `gbpusd`, …). Restricting to exactly six lowercase letters is even
 * tighter than the ticker charset, so an FX pair can never smuggle a path/host
 * into the pinned upstream (no SSRF).
 */
const FX_PAIR_RE = /^[a-z]{6}$/;
/** A numeric query value (output size). */
const NUMERIC_RE = /^\d{1,4}$/;
/** A `YYYY-MM-DD` calendar date (daily-close window bounds). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
   * @param {{ RELEASE_URL?: string, META_URL?: string, TIINGO_TOKEN?: string }} env
   */
  async fetch(request, env) {
    // The Tiingo price fallback hangs off a dedicated `…/price` route; every
    // other path is the original closed blob proxy. Both stay pinned upstreams.
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path.endsWith("/price")) {
      return handlePrice(request, env);
    }
    return handleBlob(request, env);
  },
};

/**
 * Tiingo price proxy. Injects the `TIINGO_TOKEN` secret and forwards to one of
 * two pinned `api.tiingo.com` endpoints, chosen by query params:
 *
 *   - `?tickers=AAPL,MSFT`            → IEX live quotes / latest NAV
 *   - `?daily=AAPL&startDate=…&endDate=…&outputsize=…` → daily closes
 *   - `?fx=eurusd`                    → live FX top-of-book (bid/ask/mid)
 *   - `?intraday=AAPL&startDate=…&endDate=…` → IEX 1-hour bars (1D curve)
 *
 * Everything else (host, path) is fixed here, and every caller-supplied value is
 * charset-validated, so this can only ever read Tiingo price data (no SSRF).
 *
 * @param {Request} request
 * @param {{ TIINGO_TOKEN?: string }} env
 */
async function handlePrice(request, env) {
  const cors = corsHeaders();
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { ...cors, Allow: "GET, HEAD, OPTIONS" },
    });
  }

  const token = env.TIINGO_TOKEN;
  if (!token) {
    return jsonError(503, "Tiingo fallback is not configured (no TIINGO_TOKEN secret)", cors);
  }

  const params = new URL(request.url).searchParams;
  let upstreamUrl;
  try {
    upstreamUrl = buildTiingoUrl(params);
  } catch {
    // buildTiingoUrl throws only on caller-input validation; return a fixed
    // message rather than echoing the error (no internal/stack detail leaks).
    return jsonError(400, "invalid price request parameters", cors);
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch {
    return jsonError(502, "upstream fetch failed", cors);
  }

  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

/** Build the pinned Tiingo upstream URL from validated query params. */
function buildTiingoUrl(params) {
  const tickers = params.get("tickers");
  const daily = params.get("daily");
  const fx = params.get("fx");
  const intraday = params.get("intraday");

  if (tickers) {
    const list = tickers.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    if (list.length === 0 || !list.every((t) => TICKER_RE.test(t))) {
      throw new Error("invalid tickers");
    }
    const url = new URL(`${TIINGO_ROOT}/iex/`);
    url.searchParams.set("tickers", list.join(","));
    return url.toString();
  }

  if (fx) {
    // Live FX top-of-book for one quoted pair (e.g. `eurusd`). The browser reads
    // `midPrice` and uses it directly as the EUR→USD spot. Strictly validated to
    // six lowercase letters so it can only ever name a Tiingo FX pair.
    if (!FX_PAIR_RE.test(fx)) throw new Error("invalid fx pair");
    const url = new URL(`${TIINGO_ROOT}/tiingo/fx/top`);
    url.searchParams.set("tickers", fx);
    return url.toString();
  }

  if (intraday) {
    // Intraday OHLC bars for ONE ticker, used to paint the web companion's live
    // 1D curve (proposal §10). Pinned to Tiingo's IEX `/prices` endpoint at a
    // FIXED `resampleFreq=1hour` — the caller only chooses the ticker and the
    // date window, both charset-validated, so this can only ever read Tiingo
    // intraday bars (no SSRF; the frequency is not caller-controlled).
    if (!TICKER_RE.test(intraday)) throw new Error("invalid intraday ticker");
    const url = new URL(`${TIINGO_ROOT}/iex/${intraday}/prices`);
    url.searchParams.set("format", "json");
    url.searchParams.set("resampleFreq", "1hour");
    const start = params.get("startDate");
    const end = params.get("endDate");
    if (start) {
      if (!DATE_RE.test(start)) throw new Error("invalid startDate");
      url.searchParams.set("startDate", start);
    }
    if (end) {
      if (!DATE_RE.test(end)) throw new Error("invalid endDate");
      url.searchParams.set("endDate", end);
    }
    return url.toString();
  }

  if (daily) {
    if (!TICKER_RE.test(daily)) throw new Error("invalid daily ticker");
    const url = new URL(`${TIINGO_ROOT}/tiingo/daily/${daily}/prices`);
    url.searchParams.set("format", "json");
    url.searchParams.set("resampleFreq", "daily");
    const start = params.get("startDate");
    const end = params.get("endDate");
    const size = params.get("outputsize");
    if (start) {
      if (!DATE_RE.test(start)) throw new Error("invalid startDate");
      url.searchParams.set("startDate", start);
    }
    if (end) {
      if (!DATE_RE.test(end)) throw new Error("invalid endDate");
      url.searchParams.set("endDate", end);
    }
    if (size) {
      if (!NUMERIC_RE.test(size)) throw new Error("invalid outputsize");
      // Tiingo daily has no outputsize; honoured here only as a validated no-op
      // guard so a caller can't smuggle arbitrary query text. Intentionally not
      // forwarded.
    }
    return url.toString();
  }

  throw new Error("missing tickers, fx, intraday or daily parameter");
}

/** A small JSON error body with CORS headers. */
function jsonError(status, message, cors) {
  return new Response(JSON.stringify({ status: "error", message }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * The original closed blob CORS proxy (unchanged behaviour).
 *
 * @param {Request} request
 * @param {{ RELEASE_URL?: string, META_URL?: string }} env
 */
async function handleBlob(request, env) {
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
    } catch {
      // Intentionally generic: don't echo the upstream error to clients (avoids
      // leaking internal/stack detail; see CodeQL js/stack-trace-exposure).
      return new Response("upstream fetch failed", {
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
}
