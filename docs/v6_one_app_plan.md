# v6.0 "One App": a hosted, single-backend Investment Overview

> Status: **in implementation** (2026-11-01, branch `feat/v6-one-app`). Phase 0 steps 1–2 done; the yfinance spike (step 3) is still to run (Mon 2026-11-02). Phases 1 and 3 and the agent-doable parts of Phase 2 are built (not deployed); the snapshot/intraday native-currency migration waits for the parity gate on the real ledger. Execution order and resume notes: [`v6_progress.md`](v6_progress.md). Backups changed from Litestream to sealed snapshots (Litestream can't replicate SQLCipher files). **v5.3.1 is the final, frozen legacy release** (branch `legacy/v5`, tag `v5.3.1`; see [`legacy_v5.md`](legacy_v5.md)).

## Context

Today there are two apps:
- a Python/NiceGUI **desktop app** that does the real work but only runs on the main laptop;
- a **web companion** that looks great but is a read-only copy.

The web copy gets an encrypted file from a GitHub release and polls rate-limited price APIs from the browser. That polling is the root of the sync pain: yfinance can't run in a browser, so every tab had to ration paid-provider credits. That is why there are reservation and breaker logic, budget audits, and web⇄desktop curve reconciliation.

**v6 replaces both with one always-on Python backend on a Hetzner VPS.** It:
- is the only place prices are fetched (yfinance, no keys);
- stores the encrypted ledger;
- computes every number.

The browser becomes a thin React UI that talks only to our own server, which has no limits. The design leaves room for a later OpenRouter LLM assistant.

## Locked-in decisions

| Topic | Decision |
|---|---|
| Hosting | **Hetzner Cloud VPS** (x86, 1 vCPU / 1 GB + 2 GB swap, Ubuntu 26.04 LTS, EU; rescale to a bigger plan if memory gets tight): Docker Compose + Caddy, admin over Tailscale |
| Domain | **`investments.daniel-henke.de`** (domain at Porkbun, Porkbun DNS); the main domain stays free for other uses. Let's Encrypt HTTPS via Caddy |
| Architecture | **Strong server, weak client.** The server owns data, prices, all maths and secrets; the client renders. |
| Repo layout | `backend/` + `frontend/` + `deploy/` + `docs/` (§4a, adapted from the starter-project convention) |
| Auth | App login: password (argon2) + **passkeys** (WebAuthn), httpOnly session cookie |
| Encryption | SQLCipher on ledger + config (key = server secret); sealed off-box backups |
| Frontend | New **React 19 + TypeScript** + Vite app, SCSS + BEM + design tokens, reusing current design, charts and PWA |
| Currency | **Store native, report in any currency** (§2) |
| Git flow | PRs for features and risky work; direct push to `main` OK for small or urgent fixes; deploy only after CI passes |
| Versioning | Release fast: every feature/fix ships as its own release in the same PR; `[Unreleased]` only as short-lived storage for docs/CI-only changes |

---

## 1. Project rules rewrite (the "laws")

Done in Phase 0, so every later agent works from correct rules.

**What I found:**
- **The USD rule is wrong.** It says storage and computation are "native USD" and EUR is `usd / fx`. In reality:
  - transactions store native + frozen EUR + frozen USD legs (`domain/currency.py:61`);
  - EUR returns are FX-aware, using per-cashflow date rates (`original_spec.md:474`);
  - snapshots and intraday values are stored in EUR (`models/position_snapshot.py`, `models/intraday_value.py`).

  Following the rule literally would break the EUR returns. This is the likely cause of the repeated agent mistakes.
- **The rule files contradict each other:**
  - `AGENTS.md` omits pytest and mypy;
  - `CONTRIBUTING.md` allows pushing straight to main while AGENTS.md demands PRs;
  - `.github/copilot-instructions.md` is missing half the rules.
- **Bump-per-change** triggers a tag plus an installer release every time (`tag-on-version-bump.yml` → `release.yml`).
- **Stale or aspirational rules:**
  - "domain is property-tested", but only `tests/domain/test_returns.py` uses hypothesis;
  - layering is "by convention, not tooling";
  - several rules (blob reconciliation, provider shares) are obsolete in v6.
- **Security:** the live ledger (`OneDrive\inv-dashboard\ledger.sqlite`, 1,807 transactions) opens without a key, so it is **plaintext on OneDrive today**. SQLCipher never activated on Windows.

**New rule set** (`AGENTS.md` is the single source; `copilot-instructions.md` and `CLAUDE.md` become one-line pointers):
- **Currency rule** (§2, verbatim).
- **Layering:** `api → services/readmodels → repositories/adapters → domain`, plus the cache-tier rule (cache goes only through `prices_service`/`fx_service`/`snapshots_service`). Enforce with `import-linter` in CI.
- **Strong server / weak client:** no business maths, provider calls or secrets in the frontend.
- **One quality gate** (also in CI):
  - `uv run ruff format .`
  - `uv run ruff check . --fix`
  - `uv run mypy src/investment_dashboard/domain`
  - `uv run pytest`
  - `npm run typecheck` and `npm run test` in `web/`
- **Git flow and versioning** as in the table above.
- **Property tests** are required for new money maths in `domain/` (add them for `currency.py` and `allocation.py`).

---

## 2. Currency policy: "store native, report in any currency"

The real ledger is all USD, but you think in EUR, and your euros reach the brokerages indirectly: quarterly EUR → USD batches into a separate US bank account, then USD transfers to brokerages over time. The model below handles that properly, and the code has **no primary currency**.

**The rule** (goes into AGENTS.md):
> Store every amount in its native currency; never store derived conversions. Convert only when reporting: cashflows at their own date's rate, valuations at the valuation moment's rate. The reporting currency is a parameter (default display EUR), never hard-coded. Never compute a return in one currency and convert the result into another.

**How it works:**
1. **Facts only, in native currency.** Transactions store their native amount. No `net_eur`/`net_usd` twin columns.
2. **FX is its own fact table:** daily ECB rates (Frankfurter) plus the live rate the server poller records every minute (`fx_history`, intraday FX).
3. **One computation path:** `compute(report_ccy)` for `EUR`, `USD` or anything else later.
   - Cashflows (deposits, withdrawals, dividends) are converted at their date's rate.
   - Valuations are converted at the moment's rate.

   `domain/returns.py` (xirr/twr) is already currency-agnostic.
4. **Return decomposition for a euro investor:** EUR return = investment return (in the asset's currency) + currency effect. This builds on `domain/currency_effect.py` and becomes a headline number on the Overview.
5. **Actual-EUR-sent (your real conversion rate):**
   - A new **FX conversion** record: *date, EUR sent, USD received, optional fees, note*. This captures each quarterly batch; the effective rate is `USD / EUR`.
   - Conversions fill a **USD pool**. Each USD deposit into a brokerage consumes the pool **FIFO**, so it gets the blended actual rate of the batches it came from. A deposit larger than the remaining pool uses the ECB rate for the uncovered remainder.
   - EUR returns then use the euros you really spent, including bank spread and the timing of your batches. USD returns are unaffected.
   - The intermediate US bank account stays **outside** the portfolio. It is only a rate source, so portfolio totals don't change. Tracking it as a USD cash account can come later without schema changes.
   - UI: a "Currency conversions" page (add/edit batches), with pool balance and per-deposit matching shown on the Deposits page. A Diagnostics view shows which deposits fell back to the ECB rate.
6. **Precision:** `Decimal` end to end; round only at display. Default display EUR; toggle EUR/USD.

**Migration and safety:**
- An Alembic migration adds the `fx_conversions` table. `PositionSnapshot` and `IntradayValue` change to native USD value + FX rate.
- The legacy `net_eur`/`net_usd`/`fx_rate_to_eur` columns stay read-only for one release as a cross-check, then are dropped.
- **Parity gate before cutover:**
  - On the real ledger, with no conversions entered, `compute("EUR")` must match today's EUR numbers and `compute("USD")` today's USD numbers.
  - Every difference is explained before cutover.
  - Only then are the conversion batches entered.

---

## 3. Hosting: Hetzner VPS with guardrails

**Why:** it's a passion project. A VPS teaches transferable skills (Linux, SSH, Docker, reverse proxy, TLS, backups and restores). It is the cheapest option (about €4.5/mo), flat-priced, and the data stays in the EU.

**The real risk** is an unpatched box drifting on the internet. Guardrails:
1. **Everything as code** in `deploy/`:
   - `bootstrap.sh` turns a fresh Ubuntu server into a hardened host;
   - `docker-compose.yml` runs app + Caddy + Litestream;
   - `Caddyfile` provides automatic HTTPS for the domain.

   A broken box is rebuilt in about 15 minutes.
2. **No public SSH:** admin over **Tailscale** only. `ufw` allows only 80/443.
3. **Automatic updates:** `unattended-upgrades` for the OS. GitHub Actions builds the image to GHCR on green `main`, and the server pulls it over SSH on the tailnet.
4. **Encrypted data + off-box backups:**
   - SQLCipher on the ledger;
   - Litestream continuous replication to **Backblaze B2** (10 GB free, no card needed);
   - a nightly `storage/blob_crypto.py`-sealed snapshot;
   - a "Download backup" button in Settings.
5. **`deploy/RUNBOOK.md`:** deploy, roll back (previous image tag), restore, rotate secrets, read logs. Phase 2 includes a **restore drill**.

**Domain:**
- `daniel-henke.de` is registered at **Porkbun** (WHOIS privacy and DNS included). The app lives on its own subdomain, **`investments.daniel-henke.de`**, so the main domain stays free for anything else and the app is a fully separate origin (its own cookies and passkeys).
- One `A` record points the subdomain at the server's IPv4. Caddy fetches and renews the Let's Encrypt certificate itself.
- The subdomain name is visible in public certificate logs; that is accepted. Protection comes from the login, passkeys and rate limiting, and the app sends `X-Robots-Tag: noindex`.

**yfinance from a datacentre IP:**
- Load is tiny (one batched call per minute in market hours). It is validated in Phase 0 over a full trading day.
- Fallback: keep the existing **Tiingo** server-side fallback (`services/tiingo_fallback*.py`), now with the full 50/hr budget for the one server.
- The server caches every price, so an outage only means stale prices, never an empty screen.

**Escape hatch:** the app is one Docker image, so moving hosts later is about an hour of work.

---

## 4. Architecture: strong server, weak client

I agree with this split. The one nuance is that the client caches the last API responses (TanStack Query persistence + PWA), so the app opens instantly and is viewable read-only while offline. The server stays the only source of truth.

```
Browser (phone/laptop): React UI, renders + caches, no secrets, no maths
   │ HTTPS (same origin)
   ▼
Caddy (TLS, own domain) ─► FastAPI container
                         ├─ /api/*        JSON read + write endpoints
                         ├─ /api/stream   SSE live ticks (prices, total, FX)
                         ├─ /             built React site (StaticFiles + SPA fallback)
                         ├─ scheduler     market-hours poller, intraday sampler, EOD jobs
                         └─ SQLite + SQLCipher (/data volume) ─► Litestream → B2
```

**Reuse** (under `src/investment_dashboard/`):

| Area | Modules |
|---|---|
| Domain maths | `domain/*`: returns, risk, allocation, attribution, currency_effect, market_hours, session_fx |
| Data + migrations | `models/*`, `repositories/*`, `db.py` (tiers), `migrations/` (Alembic 0001–0014) |
| Imports | `services/importer_service.py`, `adapters/importer_types.py` (`ParsedTransactionRow`, `ParseReport`), `adapters/locale_parsing.py`, `adapters/row_validation.py`, the existing broker file-format parsers in `adapters/<broker>/`, `services/manual_entry.py` |
| Market data | `adapters/yfinance_client.py`, `frankfurter_client.py`, `tiingo_client.py`, `_retry.py`, `services/prices_service.py`, `fx_service.py`, `tiingo_fallback*.py`, `auto_refresh.py`, `loop_watchdog.py`, `intraday_snapshots_service.py`, `snapshots_service.py`, `cache_janitor.py` |
| Computation | `services/metrics_service.py`, `positions_service.py`, `benchmark_service.py`, `risk_free_service.py` (refactored to `compute(report_ccy)`) |
| Read models | `readmodels/*`: these become the API response shapes |
| Security | `storage/encryption.py` (SQLCipher via `sqlcipher3-binary` on Linux), `storage/blob_crypto.py`, `api/auth.py` (constant-time token) |
| Boot | the migration + integrity parts of `boot.py`, `storage/integrity.py`, `storage/backup.py` |

### 4a. Repository structure (adapted from the starter-project convention)

Adopted from [starter-project](https://github.com/heinrichhegenbarth/starter-project) where it fits; deliberate deviations are noted.

```
backend/                     self-contained Python project
  pyproject.toml, uv.lock    (moved from repo root)
  .env.example               every setting documented; real .env never committed
  src/investment_dashboard/
    main.py                  FastAPI app: lifespan (migrations, scheduler), router registration, static files
    config.py                pydantic-settings from env/.env, cached get_settings()
    api/                     one router module per resource, all mounted under /api
    domain/ services/ repositories/ adapters/ models/ readmodels/ storage/   (existing layers)
  migrations/  tests/
frontend/                    self-contained React app (renamed from web/)
  package.json, .env.example, vite.config.ts (dev proxy /api → localhost:8000), .oxlintrc.json
  src/
    main.tsx  App.tsx        entry + router shell (routes defined in App.tsx)
    styles/                  reset.scss, tokens.scss (CSS custom properties), base.scss, _mixins.scss
    components/<Name>/       <Name>.tsx + <Name>.scss + index.ts
    pages/<Name>/            same pattern, one folder per route
    lib/                     api.ts (typed client from OpenAPI), format/currency helpers
deploy/                      bootstrap.sh, docker-compose.yml, Caddyfile, RUNBOOK.md
docs/                        architecture, plans, schema docs
Dockerfile  AGENTS.md  CHANGELOG.md  README.md
```

**Adopted:**
- `backend/`/`frontend/` split, each with its own deps and `.env.example`.
- One router per resource under `/api`.
- `fastapi dev` via `[tool.fastapi] entrypoint`.
- The Vite `/api` dev proxy (no CORS in dev; same origin in prod).
- Folder-per-component and per-page.
- **Co-located SCSS with required BEM names**, and values from `tokens.scss` only.
  - This replaces the earlier Tailwind idea: the current `web/` design is plain CSS with tokens, so it ports over almost 1:1.
- `lib/` for non-UI helpers.
- **oxlint** for the frontend (we have no frontend linter today).
- The `.gitignore` sections (`.env.*` with `!.env.example`, `.vscode/*` with `!.vscode/extensions.json`).

**Deviations:**
- **TypeScript instead of JS:** `.tsx`/`.ts`, with types generated from the backend's OpenAPI.
- **No wildcard CORS:** production is same-origin, so the CORS middleware is dev-only or omitted.
- **Keep the Python `src/` layout and the full test suites:** the starter has no tests, but ours are a key asset.
- **Accessible primitives:** dialogs, menus and tooltips use unstyled **Radix UI** primitives, styled with BEM classes, instead of hand-rolling accessibility.
- **TanStack Query** for server state.

**When it moves:** the move (`src/`, `tests/`, `migrations/`, `pyproject.toml` → `backend/`; `web/` → `frontend/`) happens as one mechanical `git mv` commit at the **start of Phase 1**, so history follows the renames. CI, AGENTS.md and the lockstep-version rule are updated in the same commit.

The import layer stays **broker-agnostic**. Parsers are plugins that emit `ParsedTransactionRow`, and adding a new broker format means adding one adapter folder.

**Delete at cutover:**
- NiceGUI: `ui/`, the `main.py` UI wiring.
- Launchers and installer: `run_dashboard.*`, `installer/`, the installer job in `release.yml`.
- Publishing: `services/publish_service.py`, `auto_publish.py`, `tools/publish_web.py`.
- Web hosting: `web/proxy/` (Worker), `.github/workflows/pages.yml`.
- Desktop storage: `storage/cloud.py`, the OneDrive sidecar handling, and keyring usage (replaced by env secrets).
- Browser data and maths code in `web/src/`:
  - providers: `prices.ts`, `quotes.ts`, `tiingo*.ts`, `reservation.ts`, `provider-*.ts`
  - blob and login: `blob.ts`, `crypto.ts`, `login-handshake.ts`
  - reconciliation: `market-sleeve.ts`, `week-repair.ts`, `data-orchestrator.ts`
  - maths: `compute.ts`, `returns.ts`, `phase4.ts`, `projection.ts`
  - parity vectors: `tests/parity`, `tools/gen_parity_vectors.py`

---

## 5. Phases

### Phase 0: Rules + de-risk
1. **Rewrite the rule files** (§1) and add `import-linter`.
2. Write `deploy/bootstrap.sh` + a minimal Dockerfile. Provision the VPS (after you've created the accounts, see "What you need to do"). Harden it, get Caddy + own-domain HTTPS working.
3. **yfinance spike:** a tiny service polls the real ~17 tickers + EUR/USD every 60 s for one trading day and logs failures and latency.
   - **Gate:** if it is throttled, Tiingo becomes co-primary.
4. Confirm the `sqlcipher3-binary` wheel works in the image.

### Phase 1: Backend becomes the API server
- **FastAPI routers in `api/`**, each a thin wrapper over a read-model or service:
  - Reads: `GET /api/overview|periods|analytics|deposits|transactions|holdings|allocations|diagnostics|graphs/{1d,1w,1m,1y,all}?ccy=EUR|USD`
  - Imports: `POST /api/imports` (upload → `ParseReport` preview) → `POST /api/imports/{id}/confirm`
  - Writes: CRUD for `/api/transactions` (manual entries) and `/api/fx-conversions`; `PUT /api/allocations`; `GET/PUT /api/settings`
  - Ops: `POST /api/refresh`, `GET /api/backup`, `POST /api/calculator` (what-if/projection on the server)
  - Live: `GET /api/stream` (SSE)
- **Pydantic response models** + an OpenAPI → TypeScript typegen (`openapi-typescript`), so frontend types can't drift from the backend.
- **Currency refactor** (§2): `compute(report_ccy)`, the `fx_conversions` table + FIFO matching in a new pure `domain/fx_pool.py` (property-tested), and the migrations.
- **Scheduler** (FastAPI lifespan task):
  - market hours: a batched quote + FX every 60 s, one `IntradayValue` sample, then an SSE push;
  - after close: closes, splits, snapshots, cache janitor;
  - off-hours: FX every 30–60 min.
- **Auth:**
  - password (argon2) + passkeys via the `webauthn` Python lib;
  - httpOnly/Secure/SameSite=Strict cookie;
  - login rate limit and idle session timeout;
  - the bearer token stays for scripts and the future LLM.
- **Config from env:** `DB_KEY`, `SESSION_SECRET`, `TIINGO_TOKEN`, `B2_*`, later `OPENROUTER_API_KEY`.
- **Untangle couplings:** move `ui/pages/_*_query.py` logic into `readmodels/` before `ui/` is deleted.
- **Tests:**
  - keep domain, services, adapters, repositories, storage and readmodels;
  - add `tests/api/` (TestClient + respx) and the parity-gate test;
  - drop `tests/ui`, `tests/installer` and the launcher tests.
  - CI test: upgrade a v5 fixture DB to v6 head and downgrade back to 0014 losslessly.

### Phase 2: Deploy + data migration
- Multi-stage `Dockerfile`: Node builds `web/` → Python 3.12-slim + uv serves API + static files.
- `deploy/docker-compose.yml` (app, Caddy, Litestream), and `.github/workflows/deploy.yml`: on green `main`, build → GHCR → pull on the server via Tailscale.
- **`tools/upload_db.py`:**
  - takes the OneDrive `ledger.sqlite` + `config.sqlite`;
  - runs `alembic upgrade`;
  - encrypts with SQLCipher;
  - uploads to `/data`.

  The cache is rebuilt on the server. Unused instruments and accounts with zero transactions are pruned.
- **Restore drill** from B2 onto a scratch volume; write the runbook.

### Phase 3: React frontend
- **Stack:** React 19 + Vite + TS, React Router 7, TanStack Query (with persistence for instant and offline opens), SCSS + BEM + `tokens.scss`, Radix UI primitives, oxlint. Structure as in §4a.
- **Reuse from `web/`:**
  - design tokens from `styles.css`/`theme.ts`, moved into `tokens.scss` (light/dark via custom properties);
  - the Inter font and the `chart.ts` SVG chart, wrapped as a component;
  - `tour.ts` content and the PWA manifest/SW;
  - `demo.ts`, now served from a server demo dataset.
- **Pages:**
  - read: Overview (with the currency-effect split), Periods, Activity, Risk, Calculator;
  - write: Import, Transactions, Currency conversions, Allocations + rebalance plan, Settings (EUR/USD, theme, timezone, passkeys, backup), Diagnostics, Onboarding.
- **Live:** an `EventSource('/api/stream')` updates the query cache. The browser never calls a third-party API.
- **Tests:** Vitest + Testing Library, plus a Playwright smoke test (login → overview → import a fixture file).

### Phase 4: Cutover + cleanup
- **Legacy freeze:** before any deletion, branch `legacy/v5` and tag `v5.3.1` from the final v5 release. Never commit to or backport to either. Documented in [`legacy_v5.md`](legacy_v5.md).
- **Rollback commitments:**
  - every v6 Alembic migration ships a working `downgrade()` back to v5's head revision (0014), tested in CI;
  - `tools/export_v5_ledger.py` decrypts (SQLCipher) and downgrades a v6 DB into a v5-compatible `ledger.sqlite` / `config.sqlite`;
  - the final pre-cutover v5 ledger is kept as a sealed (`blob_crypto`) backup.
- Run old and new in parallel for about a week and compare totals daily. Then delete the §4 list **on `main` only**; `legacy/v5` keeps everything.
- Disable GitHub Pages, the Worker, the `live-data` release and the Twelve Data key.
- Archive the plaintext OneDrive ledger as a `blob_crypto`-sealed file, then delete the plaintext copies.
- Rewrite `README.md`, `docs/architecture.md` and `CONTRIBUTING.md`. Release **6.0.0** (`pyproject.toml` + `web/package.json` + lockfiles).

### Phase 5 (later): LLM via OpenRouter
- `POST /api/assistant/chat` (SSE streaming). The key is server-side only.
- Read-only tools mapping 1:1 to read-models: `get_overview`, `get_holdings`, `get_period_returns`, `get_transactions`, `get_allocation_drift`, `simulate_rebalance`.
- A model picker in Settings, defaulting to zero-data-retention providers, with a clear notice that portfolio data leaves the server.

**Running cost:** about €4.5/mo (Hetzner) + about $10–11/yr (domain), so roughly **€5.5/mo all-in**. Tailscale, Porkbun DNS and B2 are free at our size.

---

## 6. What you need to do (I can't create accounts or handle secrets for you)

**Already possible without any accounts:** Phase 0 step 1 (rules rewrite). The backend and frontend build waits until you've confirmed the approach.

**Before the server spike (Phase 0 step 2), about 30–45 minutes:**
1. **Hetzner Cloud:** sign up at console.hetzner.cloud, verify ID/payment, and create a project. Don't create a server yet; I'll give you exact clicks.
2. **Tailscale:** sign up (free) and install it on your laptop and phone.
3. **Domain:** done: `daniel-henke.de` at Porkbun, with an `A` record for `investments`.
4. **Backblaze B2:** sign up (free 10 GB) and create a private bucket. Keys are created later, straight into the server's secrets.
5. **SSH key on your laptop**: run `ssh-keygen -t ed25519` if you don't have one, so you can paste the *public* key into Hetzner.
6. Check that `gh auth status` shows you're logged in (for PRs and GHCR).

**Secrets:** never paste passwords, tokens or keys into chat. When we get there, I'll give you the exact commands to put them into the server's `.env` and GitHub Actions secrets yourself.

---

## 7. Verification
- **Backend:** the full quality gate (§1), plus `tests/api/` and the currency parity-gate test on a copy of the real ledger.
- **Currency:** for a synthetic case (two quarterly EUR → USD batches, three brokerage deposits), check that the FIFO matching and EUR XIRR are worked out by hand in the test.
- **Live:**
  - during US market hours, SSE ticks arrive about every 60 s;
  - the 1D graph fills from server samples;
  - the network tab shows no third-party price calls from the browser.
- **Resilience:**
  - force a yfinance failure and check that Tiingo takes over;
  - reboot the VPS and check that data persists;
  - complete the B2 restore drill.
- **Security:**
  - `/api/*` returns 401 without a session;
  - the login rate limit works;
  - the cookie flags are correct;
  - the DB file is unreadable without `DB_KEY`;
  - `nmap` from outside shows only 80/443.
