# web/ — Live Web Companion (static front-end)

This directory holds the **public**, read-only GitHub Pages front-end described
in [`docs/v3.0_live_web_companion_proposal.md`](../docs/v3.0_live_web_companion_proposal.md).

## Design priority: mobile first

**Mobile is the number-one priority.** This companion exists primarily to give a
great-looking, glanceable portfolio view on a phone, in the style of a modern
neobroker. Every layout decision starts from a narrow single-column phone
viewport and only *then* scales up. A polished desktop-browser experience is an
explicit goal too, but whenever the two are in tension, **mobile wins**.

Concretely, that means:

- Single-column, thumb-reachable layout by default; wider screens get more
  breathing room, multi-column KPI grids, and — on desktop/widescreen — a
  multi-column dashboard grid (headline value beside the return horizons, a
  full-width single-row KPI strip, a two-column holdings grid with the
  allocation panel underneath, and two-column Periods/Risk/Calculator panels) so the
  extra space isn't wasted. This is layered on with `min-width` media queries
  only; the markup and mobile source order never change.
- Sections (Overview / Periods / Risk / Calculator) switch through a **tab bar** that
  is a fixed bottom navigation on phones (within thumb reach) and reflows to a
  top tab strip on desktop — same markup, `min-width` media queries only. The
  last-viewed tab is remembered per device.
- Holdings render as a scannable **list** (symbol · name · value · today's
  move), never a wide horizontal-scrolling spreadsheet table. Long lists
  (holdings and the by-month / by-year period tables) are **collapsible** so you
  can fold one away and reach the content below without scrolling past every row.
- The headline portfolio value and today's move are the hero of the screen;
  month- and year-to-date growth sit right beneath (and, on desktop, beside the
  big total value), and a **value-over-time chart** (with labelled axes, running
  to today's live value) sits on the Overview so the three return horizons are
  visible at a glance on a phone. The Overview and Risk charts carry small
  **time-range presets** (e.g. 1M / 3M / 6M / All — only those the history is
  long enough for are shown) that re-slice the already-loaded points in place,
  on phone and desktop alike.
- The gain/loss colours stay the colourblind-safe **blue ↔ orange** pair (never
  red/green) — see proposal §7.3.
- The headline value, return horizons and KPIs lead; **asset-class allocation is
  intentionally de-emphasised** into a collapsed panel below the holdings (a
  fixed, lopsided allocation does not need to be front-and-centre).
- The **Risk** tab spells out its abbreviations: each metric carries a tappable
  info dot (hover/focus on desktop, tap on mobile) with a plain-language
  definition, and the equity curve has labelled axes plus a portfolio /
  contributions / benchmark legend.
- A topbar **currency toggle** flips the whole dashboard between **EUR and USD**
  (using the live EUR→USD rate), persisted per device. A **Settings** button in
  the topbar opens the editable configuration **while logged in**. Settings lead
  with **Appearance** (the **theme** control, which cycles System → Light → Dark,
  persisted in `localStorage`; "System" follows the OS `prefers-color-scheme`),
  then **Security** (an idle **auto-lock** timeout and a **fingerprint unlock**
  toggle), the **Data source** plumbing (data source, quote cache,
  blob URL override), and a **Maintenance** section with an **Update all data
  now** button. The modern **Inter** typeface is bundled
  (self-hosted — no third-party font requests).
- **Update all (repoll from scratch).** Settings → Maintenance → *Update all data
  now* throws away every cached price (quotes, FX, EUR/USD), drops the in-memory
  data-file version stamp, and runs a forced full re-fetch of all quotes and FX
  plus a re-check of the encrypted data file — a one-tap escape hatch for when a
  value ever looks stuck behind its (deliberately long) NAV / closed-market
  freshness window. It bypasses only the soft "conserve the last credits" gate;
  the hard free-tier per-minute/day budget still applies, so it can never blow
  the daily allowance (`clearPriceCaches` in `src/cache.ts`).
- **Try the backup data provider.** Settings → Maintenance → *Try the backup data
  provider now* routes the whole book through the secondary provider (Tiingo) for
  one pull: it skips the Twelve Data primary entirely and re-prices every holding
  whose cached value isn't already recent (behind the latest settled session / its
  expected NAV), pulling all behind NAV laggards at once instead of one canary
  probe at a time. Use it for a second opinion when the primary looks wrong or
  stuck. Tiingo's own hourly/daily budget still applies, so any overflow simply
  defers and symbols already on a fresh value are left untouched (`viaTiingo` in
  `src/app.ts`, `forceAll` in `src/tiingo-fallback.ts`).
- **Idle auto-lock.** After a configurable period of inactivity (default **5
  min**; Settings → Security → *Auto-lock (minutes)*, set `0` to disable) the
  session clears the in-memory passphrase and returns to the unlock screen, so an
  unattended phone doesn't sit on an open dashboard.

## Status

**Phase 5 (PWA) implemented**, building on the Phase 4 periods/projection/
analytics work, plus an **experimental Phase 6 opt-in**: live **1D / 1W** value
graphs (Settings → Experimental → "Live graphs", **off by default** so the proven
`1M / 3M / 6M / 1Y` chart never regresses). When on, the Overview value chart
drops the longer `3M / 6M` slices and adds live 1D and 1W curves, reconstructed
from intraday/daily bars cached on the device (IndexedDB `TimeSeriesStore`) — see
`docs/v3.0_live_web_companion_proposal.md` §10.8. Two touches keep the live curves
cheap on a long watch: the 1D curve **leaves breadcrumbs** — each time the live tip
moves it persists that whole-book value (a figure already computed, so **zero
credits**), and the curve splices the trail back in so it self-thickens between the
slow, credit-conscious bar re-fetches instead of showing a lone moving dot (real
bars always supersede a breadcrumb they have since caught up to). And in the other
direction, when a build does pay to fetch price bars it **hands the newest bar back
to the holdings' quote cache** (extending freshness only, never overwriting a fresher
quote), so the holding rows reuse that price rather than re-buying it — see
`primeQuotesFromBars` in `src/cache.ts`. The companion is now an
installable **progressive web app**: a
web manifest + icon make it add-to-home-screen capable, and a service worker
caches **only the public, static app shell** so the UI opens instantly and works
offline. The service worker never caches the encrypted blob, the live price/FX
responses, or any decrypted data (that lives in memory only) — see
`public/sw.js`. A Vite + TypeScript single-page app that:

1. collects a Twelve Data API key + the data repository on a setup screen
   (the key is **encrypted at rest** in `localStorage` with a non-extractable
   per-device key in IndexedDB — see `secret-store.ts` — never in the repo),
2. downloads the encrypted `portfolio.enc` blob and decrypts it **in the
   browser** with your mobile passphrase via WebCrypto (PBKDF2-HMAC-SHA256 →
   AES-256-GCM, mirroring `storage/blob_crypto.py`) — and to make a quick
   re-open feel instant, it caches that (opaque, public-safe) ciphertext locally
   and decrypts the **cached copy first**, then re-downloads the blob in the
   background (skipping the re-download entirely if it was fetched seconds ago).
   On a phone you can also **unlock with your fingerprint** (see "Fast, easy
   login" below) instead of typing the passphrase,
3. fetches live quotes (Twelve Data) + EUR FX (Frankfurter), **engineered around
   the Twelve Data free tier** (see "Free-tier economy" below) so it degrades
   gracefully instead of dead-ending on a rate limit,
4. computes KPIs and per-holding stats with the **ported** `domain/returns`
   maths, guarded by a parity suite, and
5. renders a mobile-first dashboard split into four tabbed sections:
   - **Overview** — headline value + today/month/year growth, parity-matched
     KPIs, the holdings list and the collapsible allocation panel.
   - **Periods** — monthly and yearly tables, with the **current** month and
     year **recomputed live** (badged "live") and completed periods frozen as of
     export, plus the contributions summary and a compact forward-projection
     outlook ("if this pace holds") seeded from today's value and history.
   - **Risk** — the as-of-export analytics bundle (returns, risk metrics, an
     inline equity-curve sparkline and per-holding attribution), clearly stamped
     "as of <export>" because history-bound stats do not move intraday.
   - **Calculator** — an interactive allocation/invest planner (a port of the
     desktop app's calculator): you set a **target mix** (by category or by
     fund) and turn a cash contribution into a concrete buy-only — or, with
     rebalancing on, a buy/sell — plan that says **how much to invest** in each
     fund. Saved target allocations exported in the encrypted blob can be loaded
     with one tap.

The sections switch via a **tab bar** that is a fixed, thumb-reachable bottom
navigation on phones and reflows to a top tab strip on desktop/widescreen — the
markup is identical at every breakpoint.

## Fast, easy login

The companion is built for the common case of opening it for a minute or two to
glance at what's happening, then closing it — so the **first paint is the whole
game**. Everything slow happens *after* you're already looking at your numbers:

- **Cache-first unlock.** The encrypted blob is opaque, public-safe ciphertext,
  so it's cached locally on first download. Unlocking decrypts that **cached copy
  first** and renders immediately; the fresh blob is re-downloaded in the
  background and the view updates only if it actually changed.
- **Only re-download when there's a newer version.** The background refresh no
  longer pulls the whole blob just to compare it. It first checks a tiny
  `portfolio.meta.json` version stamp the desktop app publishes alongside the
  blob, then falls back to an HTTP **conditional GET** (`If-None-Match` /
  `If-Modified-Since`). An unchanged export comes back as a few-byte **304 Not
  Modified** — no transfer, no decrypt. A genuinely new publish is picked up
  automatically within minutes via the slow background cadence, at essentially
  zero bandwidth. (Requires the one-time CORS-proxy redeploy; see below.)
- **Warm-on-login prefetch.** The moment the unlock screen appears, the app
  starts fetching live quotes for the symbols it already knows about (from a
  cached, tickers-only *symbol plan*) **while you type your passphrase and the
  blob decrypts** — and pulls EUR FX in parallel. By the time you're in, the
  first per-minute credit window is already spent on the data you care about, so
  the dashboard paints live instead of starting the rate-limit clock from zero.
- **Biggest first.** Quotes are fetched in priority order — ETFs/stocks
  (largest EUR value first), then mutual funds (largest first); money-market
  funds are never requested (their NAV is pinned at $1). Under the per-minute
  cap, the prices that move your total the most always land first.
- **Cache-first prices.** The dashboard paints from your last cached quotes with
  zero network on the hot path, then live prices refresh in the background.
- **Fingerprint unlock (optional).** On a device with a platform authenticator
  (your phone's fingerprint / Face ID reader), flip on *"Enable fingerprint
  unlock"* when you unlock — or the **Fingerprint unlock** toggle in Settings →
  Security — and the passphrase is wrapped behind the authenticator via the
  WebAuthn **PRF** extension (`src/webauthn.ts`). After that the unlock screen
  goes **fingerprint-first**: it shows a single prominent "Unlock with
  fingerprint" button (with the passphrase tucked behind "Use passphrase
  instead") and **auto-prompts** the platform sheet on load, so a returning user
  is in with one touch and no extra tap. The passphrase is only ever stored
  AES-256-GCM-encrypted under a key the hardware re-derives on a successful
  fingerprint touch; without that touch on *this* device the stored blob is
  inert. Unsupported devices simply never see the option and keep using the
  passphrase.
- **Burst-then-slow auto-refresh.** Prices now refresh **automatically**
  (`src/refresh-policy.ts`). On startup, while the free-tier per-minute budget
  forces some symbols to be deferred, it **bursts roughly once a minute** so the
  next minute fetches the remainder — every holding reaches its latest price as
  fast as the rate limit allows. Once nothing is deferred it relaxes to a slow,
  rate-limit-friendly cadence, and it **pauses entirely while the tab is hidden**
  (then does one cheap, cache-first refresh when you return), so nothing is
  wasted in the background. As the **rolling daily credit budget** runs low the
  cadence **stretches out automatically** (`dailyBudgetSlowdown`) so a long day
  paces itself instead of exhausting the free tier early; the footer shows how
  much of the daily budget is used, and a banner warns when you're close to — or
  over — the limit.
- **Live, rotating update animation.** Every refresh (manual *or* automatic)
  visibly **spins the Refresh glyph** while data loads — not just a silent
  pop-up. For a portfolio larger than the per-minute cap, which can only be
  priced over several burst rounds, the indicator stays on **between** rounds
  and shows a live **"N of M"** fill count, so the unavoidable staging reads as
  continuous progress rather than an update that can never finish in one go.
  Because that progress is now self-evident, the app no longer raises an alarming
  banner for the ordinary "still filling in" case — only genuine stalls (a fetch
  error, or the daily budget spent) surface one.
- **Market-phase-aware refresh windows** (`src/refresh-window.ts`). What a
  refresh fetches now follows the trading clock, so credits are only ever spent
  on a price that can actually have changed:
  - **session open** → only live **stock** prices (a NAV can't strike yet);
  - **post-close, pre-NAV** → only the **awaited NAVs** (the stock closes are
    already in hand and stay quiet); and
  - **fully settled / overnight / pre-market / weekend** → the **automatic**
    scheduler fetches **nothing** *while the data is genuinely current* (every
    settled close and NAV in hand), keeping only a slow heartbeat that notices
    the next open or NAV publish. If a cached close is actually **outdated** —
    e.g. the app was offline across the close — the automatic refresh still pulls
    it even outside the session. A **manual**
    tap in this window instead **re-pulls everything from scratch** — you only tap
    Refresh off-hours when you're unsure the cache is right, so it verifies the
    whole book rather than trusting it.
- **Honest startup signal.** Opening the app answers "is this current?" *visibly*:
  if there's something to pull it shows an **immediate refreshing animation**; if
  the book is already settled and in hand it pops a small **"Prices up to date ·
  last pulled …"** toast (with *when*) instead of silently doing nothing. A
  cache-served refresh that holds every close/NAV now reads **"up to date"** rather
  than the old apologetic "showing recent prices".

## Free-tier economy (Twelve Data)

The companion is **built for the Twelve Data free tier** and never assumes a
paid plan. The free limits are the binding constraint everywhere in the
live-data layer:

- **8 API credits per minute**, **800 per day**,
- a batched `/quote` call spends **one credit per symbol** — so a portfolio with
  more than eight market holdings would blow the per-minute cap in a *single*
  refresh, which is exactly what produces an `HTTP 429` "Couldn't load live
  data" error.

To stay comfortably inside that budget the app (`src/cache.ts`, `src/quotes.ts`):

1. **Caches quotes** in `localStorage` with a freshness window (default **15
   min**, adjustable in Settings → *Quote cache (minutes)*). A tab reload,
   currency toggle, or quick re-open re-uses the cache and spends **zero
   credits**. FX is cached too (~12 h, since Frankfurter updates daily).
   **Mutual-fund NAV** holdings are also priced live, but on a
   long ~12 h window (their NAV only publishes ~once a business day), so they
   track the latest available value while barely touching the credit budget.
   Their NAV is pulled from Twelve Data's daily **`time_series`** endpoint, not
   `quote`: `quote` carries a fund's last NAV forward and stamps it with *today's*
   date even on a closed day (a weekend **or a mid-week market holiday**), which
   made a stale NAV masquerade as "today's" and dropped the value chart off a
   cliff. The daily series only ever has a bar for a real trading day, so its
   latest bar is the authentic last-published NAV — and we only adopt it over the
   exported value when that bar's value-date is strictly newer, so a closed-day
   carry-forward is never trusted (no holiday calendar of our own required).
   Within each fund's **publish window**, a NAV whose latest value-date is still
   behind today's expected one drops to the short window and is then **polled
   like an ordinary symbol until the new NAV actually lands** — there is no upper
   "catch-up" cap, so a NAV that publishes late (even past midnight) is still
   picked up the same night rather than waiting a whole day (`navCacheTtlMs` in
   `src/quotes.ts`). The "expected" NAV date is **anchored to the US trading
   session** (the calendar a NAV's value-date actually uses), capped at the
   latest session whose 16:00 ET close has happened (`latestExpectedNavDate` →
   `latestSettledSessionDate`). That is what keeps a NAV arriving in the small
   hours of the European morning — e.g. a 02:00 CET print — matched to the right
   **US** date instead of the rolled-over local one, so the local midnight switch
   never knocks a late NAV onto the wrong day or makes the app chase a value-date
   that cannot exist yet. It only relaxes back to ~12 h once today's value is in
   hand, and is never polled before its NAV could exist (before the expected
   publish hour the prior session's NAV — which we already hold — is the latest
   expected one). The expected publish hour is **learned per fund** from when its
   value-date has actually advanced (recorded in `localStorage`; see
   `navPublishWindow` / `recordNavPublish`), so a fund that strikes its NAV late
   is judged against its own habit. Before any history is observed it falls back
   to the European market close (~22:00), since a EUR-listed fund's NAV can't
   strike before its market shuts. During the session and the post-close NAV
   window a manual **Refresh** tap leaves an up-to-date NAV alone (no credit
   wasted on an unchanged value) but **will** re-pull a fund that is demonstrably
   behind its expected NAV; a tap once everything is **settled** deliberately
   re-pulls the whole book (the off-hours verification case — see
   *Market-phase-aware refresh windows* above). **Money-market funds are never
   requested** — their NAV is pinned at $1 by design, so a quote always returns
   the same dollar and would only waste a credit; they keep their exported value,
   like the synthetic cash/savings rows (which have no ticker at all).

   **Market (stock/ETF) symbols** mirror this while their exchange is *closed*:
   once we already hold the latest settled close there is nothing new to fetch
   until it reopens, so they rest on a long window and spend **zero credits**
   overnight, at weekends, and on market holidays (`marketCacheTtlMs` +
   `latestSettledSessionDate`, holiday-aware via `src/market-hours.ts`). The
   moment the regular session reopens they snap back to the short live window.
   Those saved overnight/weekend credits are exactly what funds a late-arriving
   fund NAV.
2. **Budgets itself across reloads** via a credit-spend log: it spends
   at most the credits left in the current minute/day windows and **defers** any
   overflow symbols to their last cached (or exported last-known) value,
   refreshing them on a later update. A larger portfolio therefore fills in over
   a few refreshes instead of 429-ing — surfaced live in the update indicator as
   an **"N of M"** fill count. As the **daily** window is consumed the
   auto-refresh cadence stretches out (and a banner warns near/over the cap) so
   the remaining budget lasts the day. The **per-minute** cap is a rolling 60s
   window, but the **daily** cap is measured from **00:00 UTC** — the moment
   Twelve Data actually resets the free-tier daily allowance — not a trailing 24h
   window. That means a new UTC day starts the budget cleanly back at zero, so
   last night's pulls never eat into this morning's allowance
   (`creditsSpentToday` / `startOfUtcDay` in `src/cache.ts`).
3. **Retries a 429/5xx/network blip** with capped exponential backoff (honouring
   any `Retry-After` header) before giving up.
4. **Degrades, never dead-ends**: whatever can't be fetched falls back to cached
   / exported values. The ordinary "still filling in over a few burst rounds"
   case is shown as the live update indicator's progress count rather than a
   warning; a non-blocking banner is reserved for genuine problems (a fetch
   error, FX trouble, or the daily budget being close/spent) and explains exactly
   what is stale and why. Only a genuine config error (a rejected/over-quota API
   key) shows the blocking error screen with a route to Settings.

The freshness of the data is shown **at the very top**, by the total value: the
exact market **time** when it was pulled live today (a stock/ETF tick), or a
**date** when the latest mark is older — a NAV fund or a closed market. Every
holding row carries the same **"as of" indicator** so it is always transparent
how current each price is — a clock time for a live quote pulled today, a date
for a fund's once-a-day NAV or an older quote. There is no vague "last known"
badge: a price is always labelled with the date or time it actually applies to.

A longer **Quote cache** means fewer refetches and fewer credits spent, at the
cost of slightly older prices — tune it to taste.

## Tiingo fallback (secondary provider)

Twelve Data is the primary, but it occasionally serves a **stale or missing**
mark — most visibly a mutual-fund/money-market NAV that publishes late in the
evening, or an upstream gap on a specific symbol. To cover those holes the
companion can fall back to **Tiingo** as a smart, budgeted secondary source
(mirrors the desktop app's `tiingo_fallback.py`). It is **opt-in**: nothing is
fetched from Tiingo until you deploy the proxy with a token and the route
resolves.

How it behaves:

1. **Keyless in the browser.** Tiingo's API is not CORS-readable and its token
   must stay secret, so every call goes through the same Cloudflare Worker, on a
   dedicated **`…/price`** route that injects the `TIINGO_TOKEN` secret
   server-side. Set the token once (`wrangler secret put TIINGO_TOKEN`); see
   [`web/proxy/README.md`](proxy/README.md). The `/price` route can only ever
   read pinned Tiingo price endpoints — every caller-supplied value is
   charset-validated (no SSRF).
2. **Runs only after the primary, only on the gaps.** Each refresh first does
   the Twelve Data pass; Tiingo is then asked only for the symbols that came back
   missing/stale (`src/tiingo-fallback.ts`, gated by the pure decision core in
   `src/tiingo-gate.ts`).
3. **NAV peer-confirmation + canary.** For late-publishing funds, a fresh
   target-date NAV the primary *did* return for any *other* fund is free evidence
   the cycle is flowing, so confirmed laggards are fetched after a short grace.
   With no such evidence, at most **one canary probe** (gated by an evening
   first-probe floor and a cooldown, capped per day) tests whether the cycle has
   published before any laggards are fetched — so a late NAV costs about one call,
   not a polling storm.
4. **Self-capped budget, reset on the US-market clock.** Tiingo is held to a
   conservative **40 calls/hour · 800/day** (80% of the shared account), tracked
   separately from Twelve Data and reset at **midnight US/Eastern** — the
   exchange day, not UTC (`startOfEtDay` / `recordTiingoCredits` in
   `src/cache.ts`). A manual **Refresh** tap may probe immediately (bypassing the
   timing gates) but still respects the hard caps.
5. **Never overwrites a fresher primary value** and **never dead-ends**: a Tiingo
   blip is reported, the primary's result always stands.

The current Tiingo usage — **calls this hour and today against the caps** — is
shown in the Overview footer next to the Twelve Data credit line, so the secondary
budget is just as transparent as the primary's.

## Preview the UI (sample data — no key, passphrase, or blob)

Want to *see and click through the dashboard* without setting anything up? The
app has a built-in **demo mode** that renders the full Overview + Holdings UI
from baked-in, entirely synthetic data — nothing is fetched and no real
portfolio is involved.

There are three ways to reach it:

- **On the setup screen**, click **“Preview with sample data”** (a prominent
  *“Try the live demo — no signup”* call-to-action is shown first-run).
- **On the unlock screen** (a configured, locked device), click
  **“Preview with sample data”** beneath the unlock controls — so the demo is
  reachable from the normal app link without editing the URL.
- **Via URL**, add `?demo` (or `?preview`) to the address (e.g.
  `…/index.html?demo` or, once deployed,
  `https://<user>.github.io/<repo>/?demo`).

Press **“Exit demo”** in the demo to return to the normal setup or unlock
screen.

Once inside, **every part of the demo is reachable from on-screen controls** —
the deep-link URLs below are just shortcuts. The banner's persona switcher,
Frozen/Live toggle and *Take the tour* button cover the persona, `sim` and
`tour` parameters, and the normal tab bar covers the `tab` parameter.

The demo is **feature-mapped to the real desktop app**: it runs the baked-in
sample data through the exact same `buildDashboard` compute/render pipeline, so
all four tabs (Overview / Periods / Risk / Calculator), the EUR↔USD currency
toggle, the live value chart with its FX-aware live tip, today's-move and
freshness chips all behave as they do in production.

### Interview / showcase options

Everything below is **fully offline and secret-free** — no key, no network, no
real data — so the links are safe to share or screen-share.

| Goal | URL |
| --- | --- |
| Default ("Global ETF saver") | `?demo` |
| US tech-heavy book (with a deliberate loser) | `?demo=tech` |
| Euro investor, mostly USD assets (FX divergence) | `?demo=fx` |
| Open straight to a tab | `?demo&tab=risk` (also `overview`, `periods`, `calculator`) |
| Combine persona + tab | `?demo=tech&tab=risk` |
| Auto-running guided tour | `?demo&tour=1` |
| Boot into the live-sim motion | `?demo&sim=1` |
| Full pitch link | `?demo=fx&tab=overview&tour=1&sim=1` |

Inside the demo, the banner offers:

- a **persona switcher** to jump between sample portfolios,
- a **Frozen / Live** toggle — *Frozen* is a deterministic, screenshot-stable
  snapshot; *Live* runs a seeded, gentle tick simulator that nudges prices
  within a small band so the dashboard visibly "moves" (today's-move and
  freshness chips update) with **no backend and no randomness you can't
  reproduce**, and
- a **Take the tour** button that spotlights one feature at a time.

The motion and tour both respect `prefers-reduced-motion`, and the demo's ⚙
**Settings** is a trimmed, read-only sheet (Appearance + currency + a "sample
data" note) — it never exposes the API-key, data-source, or maintenance fields.

### No command line: view it on GitHub Pages

1. In the repo, open **Settings → Pages** and set **Source: “GitHub Actions”**.
2. The existing `.github/workflows/pages.yml` builds `web/` and publishes it on
   the next push to `main` that touches `web/**` (or trigger it manually from
   the **Actions** tab → *Deploy Pages* → **Run workflow**).
3. Open the published URL with `?demo` appended — e.g.
   `https://<user>.github.io/<repo>/?demo`.

Because demo mode uses only synthetic data and the app never serves any
plaintext financial data (see *Security invariant* below), the page is safe to
view. The demo link is the only thing you need to explore the UI.

### One command: run it locally

If you'd rather not touch GitHub settings, from this `web/` directory run:

```bash
npm ci && npm run dev
```

then open the printed URL with `?demo` appended (e.g.
`http://localhost:5173/?demo`).

## Develop

```bash
cd web
npm ci
npm run dev        # local dev server
npm test           # parity + unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run build      # production build -> web/dist
```

### Parity suite

`test/returns.parity.test.ts` replays the committed
[`tests/parity/vectors.json`](../tests/parity/vectors.json) (generated from the
Python source by `tools/gen_parity_vectors.py`) to guarantee the browser maths
matches the desktop. `test/crypto.test.ts` decrypts a committed golden envelope
produced by the Python crypto, proving the two implementations interoperate.
Both run in CI (the `web` job in `.github/workflows/ci.yml`).

## How it deploys

`.github/workflows/pages.yml` builds this directory (`npm ci && npm run build`)
and publishes `web/dist` to GitHub Pages on every push to `main` that touches
`web/**`, and on manual dispatch.

**Nothing is served until** GitHub Pages is enabled in
**Settings -> Pages -> Source: "GitHub Actions"**. Keep that disabled while the
repo is private and the encrypted-ledger front-end is incomplete.

## Serving the encrypted blob (CORS proxy)

The app shell is served by Pages, but the encrypted `portfolio.enc` blob is
**not**. It is a GitHub *release asset* the desktop app overwrites on each
publish (this keeps old ciphertext out of git history and lets you re-push the
blob frequently without rebuilding the Pages site). Release-asset downloads,
however, are **not CORS-readable** from a browser, so the companion fetches the
blob through a small CORS proxy you deploy once — a Cloudflare Worker under
[`web/proxy/`](proxy/README.md). After deploying it, paste the Worker URL into
**Settings -> Blob URL override** in the app. See `web/proxy/README.md` for the
full, copy-pasteable deploy steps.

The Worker also forwards conditional-request headers (`If-None-Match` /
`If-Modified-Since`), relays upstream **304**s, exposes `ETag` / `Last-Modified`
to the browser, and serves the tiny `portfolio.meta.json` version stamp on a
`?meta` query — all of which power the "only re-download when there's a newer
version" behaviour above. **If you are upgrading from v3.0, redeploy the Worker
once** (`cd web/proxy && wrangler deploy`) to pick these up. The companion
derives the version-stamp URL from your Blob URL automatically; you only need
**Settings -> Version-file URL override** if the meta file lives elsewhere.

## Security invariant

No plaintext financial data is ever committed here or served from Pages. The
ledger is delivered as an encrypted blob and decrypted in-browser with a
passphrase held only by the user; the decrypted figures live in memory only.
The CORS proxy only ever relays opaque ciphertext and cannot decrypt anything.
The locally-cached blob (for cache-first unlock) is that same opaque ciphertext,
and the optional fingerprint unlock stores only the passphrase **encrypted**
under a key the device's authenticator re-derives on a verified touch — so
`localStorage` still never holds plaintext financial data or a usable passphrase.
The one device-local secret, the Twelve Data API key, is likewise encrypted at
rest with a non-extractable per-device key (IndexedDB), so `localStorage` never
holds the raw token.
