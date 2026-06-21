# Security Policy

## Threat model in one paragraph

Investment Dashboard is a **local-first, single-user** application. Your real
financial data lives only on your own machine (and, optionally, in your own
private cloud-sync folder). The server binds to `0.0.0.0:8080` so other devices
on **your** Wi-Fi can reach it — it is **not** meant to be exposed to the public
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

Use GitHub's **private vulnerability reporting** instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (Private vulnerability reporting must be
   enabled in *Settings → Code security*).
3. Describe the issue, the impact, and ideally a minimal reproduction.

If private reporting is unavailable, open a minimal issue that says only "security
report — please enable private reporting" without technical details, and a
maintainer will follow up.

I aim to acknowledge a report within **7 days** and to ship a fix or mitigation
for confirmed, in-scope issues as soon as is practical for a hobby project. There
is no bug-bounty program.

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
