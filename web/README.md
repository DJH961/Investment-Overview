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
  allocation panel underneath, and two-column Periods/Risk/Plan panels) so the
  extra space isn't wasted. This is layered on with `min-width` media queries
  only; the markup and mobile source order never change.
- Sections (Overview / Periods / Risk / Plan) switch through a **tab bar** that
  is a fixed bottom navigation on phones (within thumb reach) and reflows to a
  top tab strip on desktop — same markup, `min-width` media queries only. The
  last-viewed tab is remembered per device.
- Holdings render as a scannable **list** (symbol · name · value · today's
  move), never a wide horizontal-scrolling spreadsheet table.
- The headline portfolio value and today's move are the hero of the screen;
  month- and year-to-date growth sit right beneath, and a **value-over-time
  chart** (with labelled axes, running to today's live value) sits on the
  Overview so the three return horizons are visible at a glance on a phone.
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
  (using the live EUR→USD rate), persisted per device. A **theme toggle** cycles
  System → Light → Dark, also persisted in `localStorage`; "System" follows the
  OS `prefers-color-scheme`. The modern **Inter** typeface is bundled
  (self-hosted — no third-party font requests).

## Status

**Phase 5 (PWA) implemented**, building on the Phase 4 periods/projection/
analytics work. The companion is now an installable **progressive web app**: a
web manifest + icon make it add-to-home-screen capable, and a service worker
caches **only the public, static app shell** so the UI opens instantly and works
offline. The service worker never caches the encrypted blob, the live price/FX
responses, or any decrypted data (that lives in memory only) — see
`public/sw.js`. A Vite + TypeScript single-page app that:

1. collects a Twelve Data API key + the data repository on a setup screen
   (stored in `localStorage`, never in the repo),
2. downloads the encrypted `portfolio.enc` blob and decrypts it **in the
   browser** with your mobile passphrase via WebCrypto (PBKDF2-HMAC-SHA256 →
   AES-256-GCM, mirroring `storage/blob_crypto.py`),
3. fetches live quotes (Twelve Data) + EUR FX (Frankfurter),
4. computes KPIs and per-holding stats with the **ported** `domain/returns`
   maths, guarded by a parity suite, and
5. renders a mobile-first dashboard split into four tabbed sections:
   - **Overview** — headline value + today/month/year growth, parity-matched
     KPIs, the holdings list and the collapsible allocation panel.
   - **Periods** — monthly and yearly tables, with the **current** month and
     year **recomputed live** (badged "live") and completed periods frozen as of
     export, plus the contributions summary.
   - **Risk** — the as-of-export analytics bundle (returns, risk metrics, an
     inline equity-curve sparkline and per-holding attribution), clearly stamped
     "as of <export>" because history-bound stats do not move intraday.
   - **Plan** — an interactive forward-projection calculator seeded from the
     live total value and the average historical contribution; it recomputes
     in-browser at 4% / 7% / 10% scenarios as you adjust the inputs.

The sections switch via a **tab bar** that is a fixed, thumb-reachable bottom
navigation on phones and reflows to a top tab strip on desktop/widescreen — the
markup is identical at every breakpoint.

## Preview the UI (sample data — no key, passphrase, or blob)

Want to *see and click through the dashboard* without setting anything up? The
app has a built-in **demo mode** that renders the full Overview + Holdings UI
from baked-in, entirely synthetic data — nothing is fetched and no real
portfolio is involved.

There are two ways to reach it:

- **On the setup screen**, click **“Preview the dashboard with sample data”**.
- **Via URL**, add `?demo` to the address (e.g. `…/index.html?demo` or, once
  deployed, `https://<user>.github.io/<repo>/?demo`).

Press **“Exit demo”** in the demo to return to the normal setup screen.

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

## Security invariant

No plaintext financial data is ever committed here or served from Pages. The
ledger is delivered as an encrypted blob and decrypted in-browser with a
passphrase held only by the user; the decrypted figures live in memory only.
The CORS proxy only ever relays opaque ciphertext and cannot decrypt anything.
