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
