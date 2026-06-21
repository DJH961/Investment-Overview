# Security Policy

This document describes the security model of **Investment Overview** and how to
report a vulnerability. It focuses on the v3.0 *live web companion*, because that
is the only part of the project designed to be published to a public surface
(GitHub Pages + a public release asset).

## Threat model in one paragraph

Investment Overview is a **local-first, single-user** application. Your real
financial data lives only on your own machine (and, optionally, in your own
private cloud-sync folder). The desktop app is the single source of truth and
the **only** writer. The server binds to `0.0.0.0:8080` so other devices on
**your** Wi-Fi can reach it — it is **not** meant to be exposed to the public
internet. The only artifact ever published off-device is the **user-encrypted**
`portfolio.enc` blob used by the live-web companion (AES-256-GCM, PBKDF2-HMAC-
SHA256 at 600,000 iterations); it is decrypted **in the browser** with a
passphrase that is never committed, logged, or persisted to disk.

## Supported versions

This is a single-author project that ships from the tip of `main`. Only the
**latest release** receives security fixes. Older tags are not patched — please
update to the newest `v*` release before reporting an issue.

| Version | Supported |
|---|---|
| Latest release / `main` | ✅ |
| Any older tag | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(repository **Security → Report a vulnerability**; this must be enabled in
*Settings → Code security*):

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and ideally a minimal reproduction.

If private reporting is unavailable, open a minimal issue that says only "security
report — please enable private reporting" without technical details, and a
maintainer will follow up. Please allow a reasonable window for a fix before any
public disclosure.

I aim to acknowledge a report within **7 days** and to ship a fix or mitigation
for confirmed, in-scope issues as soon as is practical for a hobby project. There
is no bug-bounty program.

## Trust model — "the ciphertext is public, the passphrase is everything"

The web companion is strictly **read-only**: it can never write to the ledger.
The data it reads is shipped as a **minimized, AES‑256‑GCM encrypted blob**
(`portfolio.enc`), published as a single overwritten asset on a fixed GitHub
release. The design assumption is deliberately blunt:

- **The ciphertext is treated as public.** It may be fetched by anyone and is
  cached by CDNs. Its confidentiality rests *entirely* on the encryption.
- **The passphrase is everything.** The blob is sealed with a dedicated **mobile
  passphrase** (separate from the SQLCipher database passphrase) via
  **PBKDF2‑HMAC‑SHA256 @ 600k iterations → AES‑256‑GCM**. Anyone who knows the
  passphrase can read the blob; anyone who does not, cannot. Choose a strong,
  unique passphrase.

### What is encrypted, and what never leaves your device

- The published blob contains only a **minimized** snapshot needed to render the
  live view. The full transaction ledger is **excluded by default** (opt‑in).
- **Decrypted data lives in memory only.** The browser decrypts the blob with
  your passphrase via WebCrypto and never writes the plaintext to disk. The
  service worker caches **only the public, static app shell** — never the
  encrypted blob, the live price/FX API responses, or any decrypted data.
- The **Twelve Data API key** is entered on the website's setup screen and kept
  in that browser's `localStorage`. It is never committed to the repo.

## Secrets handling

- The GitHub **fine‑grained Personal Access Token** (scoped to *Contents: write*
  on this one repository) and the **mobile passphrase** live **only in the OS
  keyring** — never in code, `.env`, CI logs, or commits.
- CI uses repository **Secrets**; tokens are never echoed in workflow logs.
- The publish path logs only non‑sensitive metadata (repo, tag, asset name,
  byte counts, timestamps) — never payload contents, the token, or the
  passphrase.

## What is in scope

- Decryption / key-derivation weaknesses in the published `portfolio.enc`
  pipeline (`storage/blob_crypto.py` and the browser port in `web/src/crypto.ts`).
- Secrets leaking into the repository, build artifacts, logs, or the published
  blob.
- The optional read-only JSON API (`/api`) bypassing its bearer-token guard, or
  the SQLCipher-at-rest option failing to encrypt a synced tier.
- Path-traversal, injection, or deserialization issues in the import adapters
  (broker CSV/XLSX parsing) and snapshot import/export.

## What is out of scope

- Exposing the LAN server to the public internet yourself, or running it on an
  untrusted network. The server is LAN-only by design; set
  `INV_DASHBOARD_API_TOKEN` (and front it with auth) before exposing it further.
- The Twelve Data price API key persisted in browser `localStorage`. This is a
  deliberate, documented trade-off (see `web/src/config.ts`): it is a low-
  sensitivity, rate-limited, free **price-data** token, not a credential to any
  account or financial data, and it never leaves the device.
- The `docs/Comparison Files/` fixtures, which are **anonymized, fabricated**
  data with no real positions (see that folder's `README.md`).
- Social-engineering, physical access, or compromise of your own machine, cloud
  account, or GitHub account.

## Handling your own data safely

- Never commit a real brokerage export. `.gitignore` already blocks
  `docs/Comparison Files/Investments.xlsx`, `.env`, and the local SQLite tiers.
- Keep secrets (SQLCipher passphrase, GitHub publish PAT, mobile passphrase) in
  your OS keychain — the app reads them from there by default. The `.env` keys
  exist only for headless/CI use and must stay out of version control.
- Use a long, unique **mobile passphrase**: the published `portfolio.enc` is
  world-downloadable by design, so its only protection is that passphrase.

## This repository is public

**This repository is now public.** Making a repository public exposes its entire
**git history**, not just the current files, so the pre‑flip scrub in
`docs/v3.0_live_web_companion_proposal.md` §7 was completed before visibility was
flipped. The same hygiene must be **maintained** going forward:

- Real financial exports stay out of the tree **and** out of history — only the
  anonymized synthetic fixtures under `docs/Comparison Files/` are tracked. The
  real exports were purged from history (and the stale `refs/pull/<N>/head` refs
  resolved) before going public — see §7.1.
- `.gitignore` blocks real data files, `.env`, and build artefacts so they can't
  be re‑added.
- No secrets in code, history, or workflows; PAT + passphrase keyring‑only.
- A strong, unique mobile passphrase is set.

A lightweight regression guard (`tests/test_public_readiness.py`) asserts that no
obviously real export or `.env` file is tracked, so this hygiene can't silently
rot now that the tree is world‑readable.
