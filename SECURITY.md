# Security Policy

This document describes the security model of **Investment Overview v6** and how to
report a vulnerability. v6 is a single-user app hosted on a small server and reachable
from the public internet behind a login. The older LAN-only desktop and live-web
companion models (v3 to v5) no longer describe how the project is deployed.

## Threat model

**What is protected.** One person's investment ledger: holdings, transactions, balances
and the settings around them. Nothing else of value lives on the server (no payment
data, no other users).

**Who the owner trusts.** Only the owner (one account). There is no sign-up, no
multi-user mode and no first-run web setup: the password is set from the command line
on the server (`inv-dashboard-set-password`), so nobody can claim an empty instance.

**Who the attacker is.**

- An anonymous internet client who can reach the site, scan it, send large or malformed
  requests and guess credentials.
- Someone who steals a session cookie, the API token or a device the owner is signed in
  on.
- Someone who gets code into the repository or its CI (a malicious pull request, a
  compromised dependency or GitHub Action), which is the route to the production
  server.
- Someone who obtains the off-site backups (the storage bucket).

**Out of scope.** Physical access, a compromised owner laptop, a compromised GitHub,
Tailscale, Backblaze or hosting-provider account, root on the server, and denial of
service by a well-resourced attacker (the server is small on purpose).

## Controls

**Edge.** Caddy terminates TLS (automatic certificates, HSTS), applies security headers,
caps request bodies just above the largest import (12 MB), answers 404 for `/docs`,
`/redoc` and `/openapi.json`, and removes cookies, `Authorization` and `X-API-Token`
from its access log. Only ports 80 and 443 are public; SSH is reachable over Tailscale
only. The app container publishes no port and is only reachable from Caddy.

**Login.** argon2id password hashes (12-character minimum, constant-effort check so
timing does not reveal whether a password exists), optional passkeys (WebAuthn: exact
origin and RP ID, user verification, single-use challenges), per-IP and global failure
limits (IPv6 per /64). Sessions are server-side: a 256-bit random value in a `__Host-`
cookie (HttpOnly, Secure, SameSite=Strict), only its SHA-256 stored, rotated at login,
with idle and absolute expiry. State-changing requests are checked against the
configured origin. CORS is disabled in production. An optional API token (at least 32
characters, constant-time comparison) exists for scripts.

**Data at rest.** The database is SQLCipher-encrypted. Backups are sealed snapshots
(AES-256-GCM, PBKDF2 key from a separate backup passphrase) written by the app and copied
off-site by a sidecar that only adds files. A restore verifies integrity and row counts,
keeps the previous database aside, and signs every session out. The downloadable plain
backup is scrubbed of credentials and sessions.

**Application.** No user input reaches SQL unparameterised; imports are held in memory
with a TTL and a size cap; the single-page app uses no `dangerouslySetInnerHTML`, has a
strict Content-Security-Policy (no inline script), and its service worker never caches
`/api/*`. The log redactor masks tokens, header values, credential-like key/value pairs,
exception text and the configured passphrases and tokens.

**Containers.** The app runs as a non-root user with a read-only root filesystem,
`no-new-privileges`, all capabilities dropped, memory and process limits. Caddy and the
backup sidecar are restricted the same way. Base images are pinned by digest.

**Supply chain and deploy.** Every GitHub Action is pinned to a full commit SHA; Dependabot
proposes updates for Actions, Python, npm and Docker. Workflows run with read-only
tokens and do not persist checkout credentials. A deploy only runs for a CI run that was
a push to `main` of this repository, inside the `production` environment, over
Tailscale, and the deploy SSH key is restricted to one forced command
(`deploy/deploy.sh`) that accepts a git sha and four known files. The server's SSH host
key comes from a secret rather than a scan at deploy time.

## Known limitations and owner responsibilities

- Whoever holds a valid session or the API token can read all data and download
  backups. Sign out on shared devices; the app clears its local data cache on sign-out.
- The B2 key used by the backup sidecar should not be able to delete files and the
  bucket should use Object Lock; this is configured by the owner, not by code
  (`deploy/RUNBOOK.md`, "Security checklist").
- The CSP still allows inline styles (`style-src 'unsafe-inline'`) because the chart
  library sets style attributes.
- There is no automated rotation of the database key or the backup passphrase.
- The host is small and also used for development; secrets files are mode 600 but other
  accounts on the host can see process listings unless `/proc` is mounted with `hidepid`.

The owner's checklist of one-time setup steps is in `deploy/RUNBOOK.md`, "Security
checklist (owner)". `deploy/check.sh` probes the public site from outside (TLS, headers,
401 without a login, API docs not exposed, only ports 80 and 443 open).

## Supported versions

This is a single-author project that ships from the tip of `main`. Only the **latest
release** receives security fixes. Please update to the newest `v*` release before
reporting an issue.

| Version | Supported |
|---|---|
| Latest release / `main` | Yes |
| Any older tag | No |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(repository **Security -> Report a vulnerability**; this must be enabled in
*Settings -> Code security*):

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and ideally a minimal reproduction.

If private reporting is unavailable, open a minimal issue that says only "security
report - please enable private reporting" without technical details, and a maintainer
will follow up. Please allow a reasonable window for a fix before any public disclosure.
Do not test against the live site beyond harmless requests, and never run load tests: it
is a small production server.

I aim to acknowledge a report within **7 days** and to ship a fix or mitigation for
confirmed, in-scope issues as soon as is practical for a hobby project. There is no
bug-bounty program.

## In scope

- Authentication, session, passkey or origin-check bypasses; anything that returns data
  without a valid login.
- Weaknesses in the database or backup encryption, restore handling, or secrets reaching
  logs, the repository, build artefacts or backups.
- Injection, path traversal, deserialization or resource-exhaustion issues in the API and
  the broker import adapters (CSV/XLSX).
- The deploy pipeline: a way to get untrusted code built or deployed, or to widen what the
  deploy key can do.

## Out of scope

- The items under "Out of scope" in the threat model above, and social engineering.
- Running the older desktop or LAN server (v3 to v5) on an untrusted network. Those
  versions were LAN-only by design; set `INV_DASHBOARD_API_TOKEN` and keep them off the
  internet.
- The anonymised, fabricated fixtures under `docs/Comparison Files/`.

## Handling data safely in this repository

This repository is public, including its full git history.

- Never commit a real brokerage export, `.env` files, passphrases or keys. `.gitignore`
  blocks the usual data files and `tests/test_public_readiness.py` fails when an obvious
  real export is tracked.
- Real secrets live only in the server's `app.env` and `rclone.conf` (mode 600), in
  GitHub environment secrets, and in the owner's password manager.
