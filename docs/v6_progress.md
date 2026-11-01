# v6 implementation progress (resume file)

Living checklist for the v6 build on branch `feat/v6-one-app`. Any agent picking
this up after an interruption: read this file first, then `git log --oneline main..`.
Tick boxes and append to the log as steps land; commit this file with each step.

The plan ([`v6_one_app_plan.md`](v6_one_app_plan.md)) is the direction; this file is
the execution order, which deliberately differs from the plan's phase numbering.
UI contract: [`v6_frontend_design.md`](v6_frontend_design.md).

## Deviations from the plan (decided 2026-10-31)

- **`web/` stays in place** as the v5 companion until cutover; the React app is a
  new `frontend/` folder (reusing tokens/chart/tour from `web/`). Moving `web/`
  would break the live v5 companion, which must keep working until cutover.
- **Currency storage migration deferred.** `fx_conversions` + the FIFO pool ship
  now (additive). Rewriting `PositionSnapshot`/`IntradayValue` to native USD and
  dropping `net_eur`/`net_usd` waits for the parity gate on the real ledger
  (owner input). Until then the API's `?ccy=EUR|USD` selects the existing
  FX-aware EUR or USD legs; it never converts a return.
- **v6 server entry is `api/app.py:create_app()`** (script `inv-dashboard-server`);
  `main.py` stays the NiceGUI v5 entry until cutover.
- Phase 2 deploy files are written in parallel with the API (no server access
  needed). Restore drill, secrets, GHCR/Actions secrets and the real-ledger upload
  are owner steps.
- Env vars keep the `INV_DASHBOARD_` prefix (`INV_DASHBOARD_DB_PASSPHRASE` is the
  plan's `DB_KEY`).

## Working rules for every task

- Each task has an exact **OWN** list; touching anything else is a bug.
- Dependencies (`pyproject.toml`, `frontend/package.json`) are added only by the
  orchestrator (C1) or F1; later workers may not add deps.
- Shared contracts (app factory, deps, schemas base, model stubs, migration ids,
  `tests/api/conftest.py`) are written by the orchestrator; workers fill stubs.
- Every task ends green on its own targeted tests and commits only its files.
- Wave gate (orchestrator): ownership check via `git diff --stat`, targeted
  suites, ruff/mypy/typecheck, push. No next wave on red.

## Waves

### W0 — restructure + frontend base (parallel)
- [x] T0a `git mv` src/tests/migrations/tools/pyproject/uv.lock/alembic.ini → `backend/`; fix CI, launchers, installer, pre-commit, path-reading tests, AGENTS/CONTRIBUTING commands
- [x] T0b move `ui/pages/_*_query.py` into `readmodels/queries/` with re-export shims (no nicegui imports)
- [x] F1 `frontend/` tooling, all deps, tokens/SCSS, AppShell (sidebar/rail/tab bar), primitive kit, lib (api, format, prefs, queries), placeholder routes

### C1 — backend contracts (orchestrator)
- [x] deps in `pyproject.toml` (argon2-cffi, webauthn, sse-starlette or plain StreamingResponse, python-multipart)
- [x] `config.py` v6 settings
- [x] `api/app.py` factory (lifespan, routers, static/SPA, security headers), `api/deps.py`, `api/schemas/common.py`, router stubs, model stubs, migration ids, `tests/api/conftest.py`, OpenAPI export script

### W1 — backend slices + deploy + frontend widgets (parallel, ≤ 7 workers)
- [x] B1 reads A: overview, holdings, allocations (GET), graphs/{range} + schemas + tests
- [x] B2 reads B: periods, analytics, deposits, transactions (GET), diagnostics, calculator + schemas + tests
- [x] B3 writes: manual transactions CRUD, allocations PUT, settings GET/PUT, imports upload→preview→confirm, refresh, backup + tests
- [x] B4 auth: argon2 password, sessions (cookie, idle timeout), login rate limit, passkeys, bearer token kept, `set-password` CLI + tests
- [x] B5 currency (B5a): `domain/fx_pool.py` + hypothesis/golden tests, then `fx_conversions` model/migration/repo/service/router + deposit matching + tests
- [x] B6 live: scheduler (lifespan task), live bus, `/api/stream` SSE + tests
- [x] D1 deploy: multi-stage Dockerfile, `deploy/docker-compose.yml`, `Caddyfile`, `litestream.yml`, `backend/.env.example`
- [x] D2 ops: `.github/workflows/deploy.yml` (build → GHCR → SSH pull; disabled until secrets exist), `backend/tools/upload_db.py` + tests, RUNBOOK sections
- [x] F2 Chart (port `web/src/chart.ts`) + AllocationBar/Treemap + Sparkline + tests
- [x] F3 Login + passkeys + Styleguide page + PWA/service worker + `lib/live.ts`

W1 as dispatched (2026-11-01; supersedes the lines above): B1 = overview, holdings,
allocations GET+PUT+rebalance, graphs (+ extract FX-effect and rebalance maths out of
`ui/pages`); B2 = periods, analytics, deposits, diagnostics, calculator (+ extract
projection; **fix analytics USD bug**: USD bundle used `net_eur` + EUR XIRR);
B3 = transactions list/CRUD (+ extract edit logic from `ui/pages/transactions.py`),
imports with staging, settings, ops; B4 auth; B5a fx_pool + conversions (not yet
wired into XIRR); B6 runtime/scheduler/SSE. D1/D2 wait for the backup decision
(Litestream likely can't replicate SQLCipher files).

### D3 — backups + restore (after W1; owner decision 2026-11-01: option A)
SQLCipher DB stays encrypted; **no Litestream** (it can't replicate SQLCipher files).
- [x] `services/backup_service.py`: consistent snapshot (SQLite backup API) → `blob_crypto`-sealed file in `/data/backups/`; triggered by the scheduler within ~2 min after any ledger/config write (dirty flag via SQLAlchemy commit hook) + nightly; keep N hourly/daily/monthly locally
- [x] compose sidecar `backup` (rclone) syncs `/data/backups` → B2 (append-only; B2 lifecycle keeps old versions)
- [x] `inv-dashboard-restore`: fetch latest (or a chosen) snapshot, unseal, verify integrity + row counts, swap into `/data/app.sqlite` atomically with the old file kept aside; a one-command runbook path for "server gone" and "bad import"
- [x] CI restore test: seal → restore → identical row counts/checksums; runbook "Restore" section + drill checklist
- [ ] Settings "Download backup" uses the same sealed snapshot

### W1 gate — security review
- [x] one `reviewer` over B4 + app factory (auth, cookies, rate limit, headers)

### W1.5 — backend unification (owner request 2026-11-01)
- [ ] audit → `docs/v6_scoping/backend_unification.md` (duplicate currency logic, `date.today()` vs ET clock, Decimal/float, layering, tiers, duplicate helpers, naming)
- [x] B5b one canonical EUR/USD cashflow builder with the FX-pool override map, used by metrics, periods, deposits, analytics, benchmark
- [ ] U-tasks from the audit (non-overlapping OWN lists, ≤ 4 per wave)

### W2 — frontend pages on generated types (parallel)
- [x] G0 orchestrator: export `openapi.json`, `npm run gen:api`, write `lib/queries.ts` hooks for every endpoint
- [x] P1 Overview (KPIs, currency-effect split, chart, allocation, movers) + Holdings
- [ ] P2 Periods + Activity + Risk + Projection/Calculator
- [ ] P3 Transactions (list + add/edit) + Import (upload → preview → confirm)
- [x] P4 Currency conversions + Allocations/rebalance + Settings (incl. passkeys, backup) + Diagnostics + Onboarding

### W3 — integration
- [ ] full gate green, CI `frontend` job, Playwright smoke (login → overview → import), CHANGELOG, plan status line, PR

## Owner-input items (not done by agents)
- yfinance spike (Mon 2026-11-02): still to run.
- Parity gate on the real ledger → then the snapshot/intraday storage migration.
- Set secrets on the server; GHCR + Actions secrets; enable the deploy workflow.
- Run `upload_db.py` with the real ledger; restore drill; first deploy.

## Log
- 2026-10-31 branch created, tracker written; W0 started.
- 2026-11-01 plan refined into 18 narrow tasks; F1 scope narrowed.
- 2026-11-01 T0a/T0b done (8f0219c, 924c599). C1 contracts done (c65374e): v5 API → `api/legacy_v5.py`, token check → `api/token_auth.py`. Migration ids: B5 `d2a6b4c8e1f0` (down `c1f5a3b9e2d4`), B4 `e3b7c5d9f2a1` (down `d2a6b4c8e1f0`).
- W3 todo: installer tarball fallback needs `#subdirectory=backend`; verify `release.yml` `python -m build backend`.
- 2026-11-01 F1 done (b0565ac); kit reference appended to v6_frontend_design.md.
- 2026-11-01 F3 done (9b0075c + lib fix). `RequireAuth` exported from pages/Login, not yet wired into App.tsx (G0). frontend_pages scoping written.
- 2026-11-01 F2 done (2e38ca5). Chart takes numbers (callers parse decimal strings); no 1D session shading yet → P1.
- 2026-11-01 B5a done (0e2e458; golden: D1 €3600, D2 €7240, D3 €9178.18), B4 done (07fba91), D2 done (08bc208). Alembic chain 0014→0015→0016 up/down OK. Security review running.
- Integration todo after D1: deploy.yml assumes `backend/Dockerfile` + port 8080 → align to root `Dockerfile` + 8000; add `name: CI` to ci.yml. Owner: TS_OAUTH_CLIENT_ID/SECRET, DEPLOY_SSH_KEY secrets, DEPLOY_ENABLED var, ghcr login on server.
- RESUME (2026-11-01): running at cutoff risk: B1, B2, B3, B6 (backend W1), security reviewer. Done: B4, B5a, D1 (ebeed49), D2. Next: on B1–B3/B6 finish → wave gate (ruff, mypy, `pytest tests/api tests/readmodels tests/services tests/ui -q`), fix deploy.yml (root Dockerfile, port 8000), `name: CI`, apply reviewer findings, then D3, W1.5 (R0–R5 per backend_unification.md), G0 + P1–P4, W3. Keep briefs short (owner asked for token economy).
- 2026-11-01 W1 complete + gate green (1549 passed). Review fixes in be29a57. OpenAPI (35 paths) + api-types generated; RequireAuth wired. W2 started: P1–P4 + D3 (each owns `lib/queries/<area>.ts`).
- Follow-ups noted by workers: benchmark_service EUR-only (USD benchmark null) → R2; allocations PUT replaces id (repo lacks update) → R4; SSE auth slides idle timeout (needs non-sliding check) → small fix; EOD `_warm_snapshots` uses date.today() → R3; period USD columns null without FX history; `compute_instrument_metrics` wrong for multi-account instruments (merged upstream in holdings.merge_positions_by_instrument) → R6.
- P4 done (29a0a8c). Gaps → W3: shared Tour component (reads localStorage iv.tour.replay), accounts/instruments endpoints + Settings UI, onboarding state endpoint.
- D3 done (70dffb6). W3: `deploy/restore.sh` one-command fetch+restore wrapper; make GET /api/backup default kind=sealed (+test_ops, Settings link). Owner: rclone.conf, INV_DASHBOARD_BACKUP_PASSPHRASE, store secrets offline, B2 keep-all-versions, restore drill.
- P1 done (f847a96). R5 must fix *_pct units (fraction everywhere, documented in schema descriptions) then a frontend sweep (P1 divides weight_pct/Bucket.pct by 100; P4 assumes percent). Polish: Holdings group-by + row drawer, styled return-split, Chart reference-line prop.
- R0 done (f659a18 + moves in f847a96). R2/B5b done (8273ada): services/cashflows.py canonical; missing FX → None. R5 todo: DepositRecord.amount_eur nullable (now 0.00 when underivable); overview_query market verdict pass currency=USD to benchmark xirr. R1+R3 running.
- 2026-11-01 R1/R3 done (adcbb95, 9ab4c8e). P2 (368ed4c), P3 (752ec18) done. Fixed: shell render loop, login redirect loop (stale/persisted auth), Vite proxy IPv6. Manual run (dev DB + vanguard fixture): all 14 pages render on desktop + phone.
- W3 bugs from manual run: "Rate move today +37.74%" (pct units); Allocations shows "No positions yet" with positions; Holdings capital gain −€669 vs Overview total return +€379, "Up/down 0/1", Best VTI +71% vs list −2.13% (semantics mismatch); login eye icon outside input; NO accounts API (fresh install can't import) → add GET/POST/PUT /api/accounts + Settings UI + import account picker; tests/models/test_schema.py table list needs v6 tables.
