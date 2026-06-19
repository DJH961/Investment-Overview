# web/ — Live Web Companion (static front-end)

This directory holds the **public**, read-only GitHub Pages front-end described
in [`docs/v3.0_live_web_companion_proposal.md`](../docs/v3.0_live_web_companion_proposal.md).

## Status

**Placeholder only.** `index.html` is a holding page. The real Phase 3
front-end (TypeScript + Vite) is not built yet.

## How it deploys

`.github/workflows/pages.yml` publishes this directory to GitHub Pages on every
push to `main` that touches `web/**`, and on manual dispatch.

**Nothing is served until** GitHub Pages is enabled in
**Settings → Pages → Source: "GitHub Actions"**. Keep that disabled while the
repo is private and the encrypted-ledger front-end is incomplete.

## When the front-end is built

1. Add the Vite/TypeScript project here (or a subfolder).
2. In `pages.yml`, replace the placeholder **Build site** step with
   `npm ci && npm run build` and point `upload-pages-artifact` at the build
   output (e.g. `web/dist`).
3. Only then enable Pages and flip the repo to public.

## Security invariant

No plaintext financial data is ever committed here or served from Pages. The
ledger is delivered as an encrypted blob and decrypted in-browser with a
passphrase held only by the user.
