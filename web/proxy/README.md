# `web/proxy/` — CORS proxy for the encrypted blob

A tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/) that makes
the published `portfolio.enc` release asset readable from the browser companion.

## Why it's needed

The desktop app publishes the encrypted blob as a **GitHub release asset** that
it overwrites on every publish. That keeps old ciphertext out of git history
(good), and lets you re-push the blob as often as you like without rebuilding
the Pages site. **But** GitHub release-asset downloads are **not CORS-readable**:
`https://github.com/<owner>/<repo>/releases/download/<tag>/portfolio.enc`
redirects to `release-assets.githubusercontent.com`, which returns **no**
`Access-Control-Allow-Origin` header. So a browser on the GitHub Pages origin is
blocked from `fetch()`-ing it and the Unlock screen shows *"could not reach the
encrypted data … (CORS)"*.

This Worker fetches the asset **server-side** (where CORS does not apply) and
re-emits the bytes with `Access-Control-Allow-Origin: *`. It is the one external
piece the companion needs; everything else stays GitHub-native.

The same Worker also hosts the **Tiingo price-fallback** route (`…/price`) — see
[Tiingo price fallback](#tiingo-price-fallback) below.

### Is the proxy safe?

Yes. It only ever handles **opaque AES-256-GCM ciphertext** — it cannot decrypt
anything, and your mobile passphrase never leaves your browser. The Worker is
also **not an open proxy**: the upstream URL is pinned to your single release
asset via the `RELEASE_URL` var, so it can't be abused to fetch other targets.

## Deploy (one-time, ~5 minutes)

You need a free Cloudflare account and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
(`npm install -g wrangler`).

```sh
cd web/proxy

# 1. Log in to Cloudflare (opens a browser).
wrangler login

# 2. (Optional) If your owner/repo or release tag differ from the default,
#    edit RELEASE_URL in wrangler.toml first.

# 3. Deploy.
wrangler deploy
```

`wrangler deploy` prints the Worker's public URL, e.g.:

```
https://investment-overview-blob-proxy.<your-subdomain>.workers.dev
```

## Wire it into the companion

Open the web companion → **Settings** and paste that Worker URL into the
**“Blob URL override”** field, then Save. From then on the app downloads the blob
through the proxy.

You set this **once**. It is independent of how often you re-publish the blob —
each publish overwrites the same release asset, and the proxy always serves the
latest bytes (it sends `Cache-Control: no-store` and never caches upstream).

## Test it

```sh
# Should return 200 with `access-control-allow-origin: *` and
# `content-type: application/octet-stream`.
curl -i "https://investment-overview-blob-proxy.<your-subdomain>.workers.dev"
```

## Local dev

```sh
cd web/proxy
wrangler dev      # serves the Worker at http://localhost:8787
```

## Tiingo price fallback

The companion's primary live-quote source is Twelve Data (a free API key the user
holds in the browser). When Twelve Data is missing data for a symbol, or its
free-tier per-minute/day budget is spent, the app can fall back to **Tiingo** for
US tickers. Tiingo's API is **not** CORS-readable from a browser and the token
must stay secret, so the same Worker proxies it on a dedicated `…/price` route:

- `GET …/price?tickers=AAPL,MSFT` → Tiingo **IEX** (`/iex/?tickers=…`): a live
  intraday mark for stocks/ETFs and the latest NAV for mutual funds.
- `GET …/price?daily=AAPL&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` → Tiingo
  **daily** closes (`/tiingo/daily/<ticker>/prices`, `resampleFreq=daily`). The
  forwarded `startDate`/`endDate` window is what feeds the 1W-and-beyond daily
  closes.
- `GET …/price?fx=eurusd` → Tiingo **FX** top-of-book
  (`/tiingo/fx/top?tickers=eurusd`): the live EUR→USD bid/ask/mid, used as the
  **backup live FX provider** behind Twelve Data for the home-currency rate. The
  pair is validated to exactly six lowercase letters (tighter than the ticker
  charset). Tiingo's `midPrice` is already USD-per-EUR, so the browser uses it
  directly (no inversion).
- `GET …/price?fxHistory=eurusd&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&resampleFreq=1day`
  → Tiingo **FX history** (`/tiingo/fx/eurusd/prices`): per-bar EUR→USD closes
  that backfill each graph point at its own settled FX rate, in one batched
  request that mirrors the daily-close window above. `resampleFreq` defaults to
  `1day` (the 1W graph) and also accepts `1hour`/`5min` (the 1D graph's intraday
  FX), validated to a positive integer followed by `min`, `hour` or `day`.
- `GET …/price?intraday=AAPL&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` → Tiingo
  **IEX intraday bars** (`/iex/<ticker>/prices`) at a **fixed** `resampleFreq=1hour`
  (one ticker per request), used to build the web companion's live **1D curve**
  (proposal §10). The frequency is pinned server-side — the caller only chooses
  the ticker and the date window, both charset-validated.
- `GET …/iex-intraday?ticker=AAPL&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&resampleFreq=1hour`
  → Tiingo **IEX intraday bars** (`/iex/<ticker>/prices`) for the live 1D/1W
  graph backfill. `resampleFreq` defaults to `1hour` and accepts a positive
  integer followed by `min` or `hour` (e.g. `5min`, `30min`). This runs on
  Tiingo's separate budget so the bulk history fetch never steals the live
  price's Twelve Data slots.

The routes inject the `TIINGO_TOKEN` **secret** as an `Authorization: Token …`
header (never in the URL), validate every ticker/date/frequency against a strict
charset (so it stays a closed, non-SSRF proxy: only `api.tiingo.com` price data,
never an arbitrary target), and stamp the same CORS headers. The browser stays
**Tiingo-keyless** — the token lives only in the Worker.

### Hourly Tiingo reserve

Both Tiingo routes share a per-isolate, rolling **one-hour request counter**
(default **40/hr**, overridable via the `TIINGO_HOURLY_RESERVE` var in
`wrangler.toml`). Once the reserve is spent the Worker answers `429` with a
`Retry-After` header, so the browser degrades gracefully — it falls back to its
Twelve Data path — instead of hammering Tiingo. The cap is best-effort per
isolate (Cloudflare may run several), enough to keep a single busy browser from
blowing the reserve.

### Set the secret (one-time)

```sh
cd web/proxy
wrangler secret put TIINGO_TOKEN   # paste your Tiingo API token when prompted
wrangler deploy
```

> **Adding the FX backup to an already-deployed Worker?** The FX route reuses the
> **same** `TIINGO_TOKEN` secret — there is **no new secret to set**. You only need
> to **redeploy** the latest `worker.js` so the new `?fx=eurusd` branch ships:
>
> ```sh
> cd web/proxy
> wrangler deploy            # picks up the new fx route in worker.js
> ```
>
> If you have never set `TIINGO_TOKEN` (you weren't using the price fallback yet),
> run the `wrangler secret put TIINGO_TOKEN` step above first, then `wrangler deploy`.

### Test it

```sh
# Should return 200 JSON with `access-control-allow-origin: *`.
curl -i "https://investment-overview-blob-proxy.<your-subdomain>.workers.dev/price?tickers=AAPL"

# The FX backup route — should return a JSON array like
# [{"ticker":"eurusd","bidPrice":…,"askPrice":…,"midPrice":…,"quoteTimestamp":…}].
curl -i "https://investment-overview-blob-proxy.<your-subdomain>.workers.dev/price?fx=eurusd"

# The intraday-bars route (1D curve) — should return a JSON array of 1-hour OHLC
# bars for the one ticker between the given dates.
curl -i "https://investment-overview-blob-proxy.<your-subdomain>.workers.dev/price?intraday=AAPL&startDate=2026-06-22&endDate=2026-06-23"
```

The companion auto-derives the `/price` URL from the blob Worker origin, so once
the blob proxy is wired up there is usually nothing else to set. An explicit
override is available under **Settings → Price proxy URL** if needed.
