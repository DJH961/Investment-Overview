# web/ — Live Web Companion (static front-end)

This directory holds the **public**, read-only GitHub Pages front-end described
in [`docs/v3.0_live_web_companion_proposal.md`](../docs/v3.0_live_web_companion_proposal.md).

## Status

**Phase 3 (Web hero) implemented.** A Vite + TypeScript single-page app that:

1. collects a Twelve Data API key + the data repository on a setup screen
   (stored in `localStorage`, never in the repo),
2. downloads the encrypted `portfolio.enc` blob and decrypts it **in the
   browser** with your mobile passphrase via WebCrypto (PBKDF2-HMAC-SHA256 →
   AES-256-GCM, mirroring `storage/blob_crypto.py`),
3. fetches live quotes (Twelve Data) + EUR FX (Frankfurter),
4. computes KPIs and per-holding stats with the **ported** `domain/returns`
   maths, guarded by a parity suite, and
5. renders an Overview + per-holding dashboard.

Completed-period and analytics *display* land in Phase 4; those blocks already
ride along in the export.

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

## Security invariant

No plaintext financial data is ever committed here or served from Pages. The
ledger is delivered as an encrypted blob and decrypted in-browser with a
passphrase held only by the user; the decrypted figures live in memory only.
