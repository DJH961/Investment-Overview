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
 * `api.tiingo.com` — the IEX quote endpoint (`/iex/?tickers=…`) and the daily
 * close endpoint (`/tiingo/daily/<ticker>/prices`) — injecting the `TIINGO_TOKEN`
 * secret server-side so the browser companion stays Tiingo-keyless. Symbols are
 * validated against a strict charset (still no SSRF: the upstream host and paths
 * are fixed; only the ticker list and a few numeric/date query params vary).
 * The token is sent as an `Authorization: Token …` header, never in the URL, so
 * it never lands in a log or a referrer. See web/proxy/README.md to deploy and
 * `wrangler secret put TIINGO_TOKEN`.
 *
 * Tiingo intraday curve (`/iex-intraday` route)
 * ---------------------------------------------
 * A third pinned route, `…/iex-intraday`, powers the live 1D/1W graph backfill
 * (design Phase 3). It proxies **only** the Tiingo IEX intraday-bars endpoint
 * `GET https://api.tiingo.com/iex/<ticker>/prices?resampleFreq=…&startDate=…&endDate=…`,
 * reusing the same `TICKER_RE`/`DATE_RE` validators and `Authorization: Token …`
 * header injection as `/price`. Running the bulk history fetch on Tiingo's
 * separate budget keeps it from ever stealing the live price's Twelve Data slots.
 *
 * Hourly Tiingo budget
 * --------------------
 * Both Tiingo routes (`/price`, `/iex-intraday`) share a per-isolate, rolling
 * one-hour request counter (default reserve {@link TIINGO_HOURLY_RESERVE}/hr,
 * overridable via the `TIINGO_HOURLY_RESERVE` var). When the reserve is spent the
 * Worker answers `429` with a `Retry-After` header so the browser degrades
 * gracefully (it falls back to its Twelve Data path) instead of hammering Tiingo.
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
/** A numeric query value (output size). */
const NUMERIC_RE = /^\d{1,4}$/;
/** A `YYYY-MM-DD` calendar date (daily-close window bounds). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Allowed intraday resample frequency: a positive integer followed by `min` or
 * `hour` (e.g. `1hour`, `5min`, `30min`). Kept to this closed charset so the
 * `resampleFreq` query value can never smuggle path/host text into the pinned
 * upstream (no SSRF).
 */
const INTRADAY_FREQ_RE = /^[1-9]\d{0,3}(?:min|hour)$/;
/** Default intraday bar width when the caller omits `resampleFreq`. */
const DEFAULT_INTRADAY_FREQ = "1hour";

/**
 * Per-isolate rolling-hour reserve of Tiingo upstream requests. The design
 * reserves ~40/hr for Tiingo; once spent, the Worker returns 429 + Retry-After so
 * the browser falls back to Twelve Data instead of hammering Tiingo. Overridable
 * via the `TIINGO_HOURLY_RESERVE` var.
 */
const TIINGO_HOURLY_RESERVE = 40;
/** One hour in milliseconds — the budget window. */
const HOUR_MS = 60 * 60 * 1000;
/**
 * Timestamps (ms) of recent Tiingo upstream requests served by THIS isolate.
 * Cloudflare may run many isolates, so this is a best-effort, conservative cap
 * per isolate rather than a globally exact quota — enough to keep a single busy
 * browser from blowing the hourly reserve. Pruned to the trailing hour on use.
 */
const tiingoRequestLog = [];

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
   * @param {{ RELEASE_URL?: string, META_URL?: string, TIINGO_TOKEN?: string, TIINGO_HOURLY_RESERVE?: string }} env
   */
  async fetch(request, env) {
    // The Tiingo price fallback hangs off a dedicated `…/price` route, and the
    // intraday-curve backfill off `…/iex-intraday`; every other path is the
    // original closed blob proxy. All stay pinned upstreams.
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path.endsWith("/iex-intraday")) {
      return handleIexIntraday(request, env);
    }
    if (path.endsWith("/price")) {
      return handlePrice(request, env);
    }
    return handleBlob(request, env);
  },
};

/**
 * Reserve one slot in the per-isolate rolling-hour Tiingo budget. Prunes the
 * request log to the trailing hour, then either records `now` and returns
 * `{ ok: true }`, or — when the reserve is already full — returns `{ ok: false,
 * retryAfterSec }` with the whole seconds until the oldest in-window request ages
 * out. Best-effort per isolate (see {@link tiingoRequestLog}).
 *
 * @param {number} now
 * @param {number} cap
 * @returns {{ ok: true } | { ok: false, retryAfterSec: number }}
 */
function reserveTiingoSlot(now, cap) {
  const cutoff = now - HOUR_MS;
  while (tiingoRequestLog.length > 0 && tiingoRequestLog[0] <= cutoff) {
    tiingoRequestLog.shift();
  }
  if (tiingoRequestLog.length >= cap) {
    const retryAfterMs = tiingoRequestLog[0] + HOUR_MS - now;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  tiingoRequestLog.push(now);
  return { ok: true };
}

/** Resolve the hourly Tiingo reserve from env, falling back to the default. */
function hourlyReserve(env) {
  const raw = Number(env.TIINGO_HOURLY_RESERVE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : TIINGO_HOURLY_RESERVE;
}

/**
 * Tiingo price proxy. Injects the `TIINGO_TOKEN` secret and forwards to one of
 * two pinned `api.tiingo.com` endpoints, chosen by query params:
 *
 *   - `?tickers=AAPL,MSFT`            → IEX live quotes / latest NAV
 *   - `?daily=AAPL&startDate=…&endDate=…&outputsize=…` → daily closes
 *
 * Everything else (host, path) is fixed here, and every caller-supplied value is
 * charset-validated, so this can only ever read Tiingo price data (no SSRF).
 *
 * @param {Request} request
 * @param {{ TIINGO_TOKEN?: string, TIINGO_HOURLY_RESERVE?: string }} env
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

  // Spend one slot of the shared hourly Tiingo reserve. When exhausted, tell the
  // browser to back off (it degrades to its Twelve Data path) rather than piling
  // onto Tiingo.
  const slot = reserveTiingoSlot(Date.now(), hourlyReserve(env));
  if (!slot.ok) {
    return rateLimited(slot.retryAfterSec, cors);
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

/**
 * Tiingo intraday-curve proxy (`…/iex-intraday`). Forwards **only** to the pinned
 * IEX intraday-bars endpoint
 *   `GET https://api.tiingo.com/iex/<ticker>/prices?resampleFreq=…&startDate=…&endDate=…`
 * for the live 1D/1W graph backfill, on Tiingo's separate budget so it never
 * steals the live price's Twelve Data slots. Host and path are fixed; only the
 * charset-validated ticker, dates and resample frequency vary (no SSRF), and the
 * `TIINGO_TOKEN` is injected as an `Authorization: Token …` header (never in the
 * URL). Shares the hourly reserve with `/price`.
 *
 * @param {Request} request
 * @param {{ TIINGO_TOKEN?: string, TIINGO_HOURLY_RESERVE?: string }} env
 */
async function handleIexIntraday(request, env) {
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
    upstreamUrl = buildTiingoIntradayUrl(params);
  } catch {
    return jsonError(400, "invalid intraday request parameters", cors);
  }

  const slot = reserveTiingoSlot(Date.now(), hourlyReserve(env));
  if (!slot.ok) {
    return rateLimited(slot.retryAfterSec, cors);
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

  if (tickers) {
    const list = tickers.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    if (list.length === 0 || !list.every((t) => TICKER_RE.test(t))) {
      throw new Error("invalid tickers");
    }
    const url = new URL(`${TIINGO_ROOT}/iex/`);
    url.searchParams.set("tickers", list.join(","));
    return url.toString();
  }

  if (daily) {
    if (!TICKER_RE.test(daily)) throw new Error("invalid daily ticker");
    const url = new URL(`${TIINGO_ROOT}/tiingo/daily/${daily}/prices`);
    url.searchParams.set("format", "json");
    // Pin the resample to daily closes (the only frequency this route serves):
    // this is what gives 1W-and-beyond their daily-close bars over the forwarded
    // startDate/endDate window.
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
      // Tiingo daily has no outputsize; the date window (startDate/endDate above)
      // is what bounds the range. Validated here only as a no-op guard so a caller
      // can't smuggle arbitrary query text. Intentionally not forwarded.
    }
    return url.toString();
  }

  throw new Error("missing tickers or daily parameter");
}

/**
 * Build the pinned Tiingo IEX intraday-bars upstream URL from validated query
 * params, for the `…/iex-intraday` route:
 *
 *   `?ticker=AAPL&startDate=…&endDate=…&resampleFreq=1hour`
 *     → `https://api.tiingo.com/iex/AAPL/prices?resampleFreq=1hour&startDate=…&endDate=…`
 *
 * Only the ticker, the two dates and the resample frequency vary, each against a
 * strict charset; the host and path are fixed (no SSRF).
 */
function buildTiingoIntradayUrl(params) {
  const ticker = params.get("ticker");
  if (!ticker || !TICKER_RE.test(ticker)) throw new Error("invalid ticker");

  const freq = params.get("resampleFreq") || DEFAULT_INTRADAY_FREQ;
  if (!INTRADAY_FREQ_RE.test(freq)) throw new Error("invalid resampleFreq");

  const url = new URL(`${TIINGO_ROOT}/iex/${ticker}/prices`);
  url.searchParams.set("format", "json");
  url.searchParams.set("resampleFreq", freq);

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

/** A 429 response telling the caller when the hourly Tiingo reserve frees up. */
function rateLimited(retryAfterSec, cors) {
  return new Response(
    JSON.stringify({ status: "error", message: "Tiingo hourly reserve exhausted; try later" }),
    {
      status: 429,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    },
  );
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
