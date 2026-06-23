# Updating your Cloudflare Worker for the Tiingo **backup live FX** provider

> Audience: the person who runs the live‑web companion and owns the Cloudflare
> Worker. This is the **detailed, do‑this checklist** for the one external change
> the Tiingo backup FX provider needs: **redeploying your existing Worker**.
> Written 2026‑06‑23. Companion design notes live in `docs/tiingo_forex_fallback.md`;
> the deploy basics live in `web/proxy/README.md`.

## TL;DR — what you actually have to do

1. **Pull the latest `web/proxy/worker.js`** (it now has a `?fx=eurusd` branch).
2. **Redeploy** it: `cd web/proxy && wrangler deploy`.
3. **Nothing else.** No new secret, no new route name, no Settings change, no app
   re‑publish. The FX backup hangs off the **same** `…/price` route and reuses
   the **same** `TIINGO_TOKEN` you already set for the price fallback.

If you have **never** deployed the Worker (or never set `TIINGO_TOKEN`), do the
full one‑time setup in `web/proxy/README.md` first, then come back here.

## Why a redeploy is all that's needed

The backup FX rate is fetched from Tiingo's **Forex** feed
(`GET https://api.tiingo.com/tiingo/fx/top?tickers=eurusd`). Tiingo's API is not
CORS‑readable from a browser and its token must stay secret, so — exactly like
the instrument‑price fallback — the browser never calls Tiingo directly. It calls
**your Worker**, which injects the token server‑side.

That FX call rides the **existing** `…/price` route. The only change is new code
in `worker.js`: a `?fx=<pair>` branch that builds the pinned
`tiingo/fx/top?tickers=<pair>` upstream. Because:

- the **route** (`…/price`) is unchanged,
- the **secret** (`TIINGO_TOKEN`) is unchanged and reused, and
- the companion **auto‑derives** the `/price` URL from your blob‑proxy origin,

…the only thing your Cloudflare deployment is missing is the **new code**. A
`wrangler deploy` ships it. That's the whole job.

## Step‑by‑step

### 1. Get the latest Worker code

Make sure your checkout includes the updated `web/proxy/worker.js` (the one with
the `FX_PAIR_RE` constant and the `if (fx) { … }` branch in `buildTiingoUrl`).

### 2. (Only if you never set it) set the Tiingo token secret

```sh
cd web/proxy
wrangler secret put TIINGO_TOKEN     # paste your Tiingo API token when prompted
```

Already using the price fallback? **Skip this** — the FX route reuses the same
secret.

### 3. Redeploy

```sh
cd web/proxy
wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://investment-overview-blob-proxy.<your-subdomain>.workers.dev`.

### 4. Verify the FX route

```sh
# Live EUR/USD top-of-book — expect HTTP 200 and a JSON array like:
# [{"ticker":"eurusd","bidPrice":1.138,"askPrice":1.138,"midPrice":1.138,"quoteTimestamp":"…"}]
curl -i "https://investment-overview-blob-proxy.<your-subdomain>.workers.dev/price?fx=eurusd"

# A bad pair must be rejected by the Worker itself (HTTP 400, no upstream call):
curl -i "https://investment-overview-blob-proxy.<your-subdomain>.workers.dev/price?fx=eur/usd"
```

Expected:

- `?fx=eurusd` → **200** with `access-control-allow-origin: *` and a one‑element
  JSON array carrying `midPrice`.
- `?fx=eur/usd` (or any non‑six‑lowercase‑letter value) → **400**
  `{"status":"error","message":"invalid price request parameters"}`.
- If you ever see **503** `Tiingo fallback is not configured`, the
  `TIINGO_TOKEN` secret isn't set on this Worker — run step 2, then redeploy.
- If you see a **non‑array** 200 body (e.g. the encrypted blob), you redeployed
  the wrong code/route — confirm you deployed the updated `worker.js`.

### 5. (No app change required)

The companion already points at this Worker (Settings → *Blob URL override*, with
the `/price` URL auto‑derived). Once the Worker is redeployed, the next live
refresh will use Tiingo for EUR/USD automatically **whenever Twelve Data can't
deliver a fresh rate** (no key, budget spent, a transient failure, or the weekend
FX close). You'll see the FX freshness label read **“FX live (backup)”** on those
rounds. You can force a check with **Settings → “Try the backup data provider
now.”**

## What the Worker now accepts on `…/price`

| Query | Upstream (pinned `api.tiingo.com`) | Purpose |
|---|---|---|
| `?tickers=AAPL,MSFT` | `/iex/?tickers=…` | live equity/ETF marks + latest fund NAV |
| `?daily=AAPL&startDate=…&endDate=…` | `/tiingo/daily/<t>/prices` | daily closes |
| **`?fx=eurusd`** | **`/tiingo/fx/top?tickers=eurusd`** | **live EUR→USD bid/ask/mid (new)** |

All three inject `Authorization: Token <TIINGO_TOKEN>` server‑side and validate
every caller value against a strict charset, so the Worker stays a **closed,
non‑SSRF proxy** — it can only ever read Tiingo data, never an arbitrary target.
The FX pair is validated to **exactly six lowercase letters** (`/^[a-z]{6}$/`),
which is tighter than the equity ticker charset.

## Budget & rate limits (nothing to configure)

The FX call is **one** Tiingo call and only fires when the primary FX source
can't deliver. The companion counts it against the **same** web‑side Tiingo budget
as the price fallback (40/hr · 800/day, reset at midnight US/Eastern), so it can't
run away even during a sustained primary‑FX outage. There is no Worker‑side limit
to set.

## Rollback

The change is purely additive (a new branch on an existing route). To roll back,
redeploy the previous `worker.js`, or in the Cloudflare dashboard:
**Workers & Pages → your Worker → Deployments → Rollback**. The blob proxy, the
IEX route and the daily route are untouched by this change.

## Security notes

- The token is **never** put in a URL — it rides the `Authorization` header, so it
  can't land in a log or a referrer. The browser stays Tiingo‑keyless.
- The same token already in your Worker is reused; nothing new is exposed.
- If your token was ever pasted somewhere it shouldn't be (e.g. a chat transcript
  during testing), rotate it at tiingo.com, then
  `wrangler secret put TIINGO_TOKEN` again and `wrangler deploy`.
