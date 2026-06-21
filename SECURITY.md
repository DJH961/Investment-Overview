# Security Policy

This document describes the security model of **Investment Overview** and how to
report a vulnerability. It focuses on the v3.0 *live web companion*, because that
is the only part of the project that is designed to be published to a public
surface (GitHub Pages + a public release asset).

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(repository **Security → Report a vulnerability**). Do **not** open a public issue
for a security problem. Please allow a reasonable window for a fix before any
public disclosure.

## Trust model — "the ciphertext is public, the passphrase is everything"

The desktop app is the single source of truth and the **only** writer. The web
companion is strictly **read-only**: it can never write to the ledger.

The data the companion reads is shipped as a **minimized, AES‑256‑GCM encrypted
blob** (`portfolio.enc`), published as a single overwritten asset on a fixed
GitHub release. The design assumption is deliberately blunt:

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

## Before making this repository public

Making a repository public exposes its entire **git history**, not just the
current files. See `docs/v3.0_live_web_companion_proposal.md` §7 for the full
pre‑flip checklist. In short, before flipping visibility:

- Real financial exports must be removed **and purged from history** (or pushed
  to a fresh repository). Note that GitHub keeps immutable `refs/pull/<N>/head`
  refs that a force‑push cannot rewrite — see §7.1.
- `.gitignore` must block real data files, `.env`, and build artefacts.
- No secrets in code, history, or workflows; PAT + passphrase keyring‑only.
- A strong, unique mobile passphrase must be set.

A lightweight regression guard (`tests/test_public_readiness.py`) asserts that no
obviously real export or `.env` file is tracked, so the checklist can't silently
rot.
