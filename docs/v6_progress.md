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
- [ ] B1 reads A: overview, holdings, allocations (GET), graphs/{range} + schemas + tests
- [ ] B2 reads B: periods, analytics, deposits, transactions (GET), diagnostics, calculator + schemas + tests
- [ ] B3 writes: manual transactions CRUD, allocations PUT, settings GET/PUT, imports upload→preview→confirm, refresh, backup + tests
- [ ] B4 auth: argon2 password, sessions (cookie, idle timeout), login rate limit, passkeys, bearer token kept, `set-password` CLI + tests
- [ ] B5 currency: `domain/fx_pool.py` + hypothesis/golden tests, then `fx_conversions` model/migration/repo/service/router + deposit matching + tests
- [ ] B6 live: scheduler (lifespan task), live bus, `/api/stream` SSE + tests
- [ ] D1 deploy: multi-stage Dockerfile, `deploy/docker-compose.yml`, `Caddyfile`, `litestream.yml`, `backend/.env.example`
- [ ] D2 ops: `.github/workflows/deploy.yml` (build → GHCR → SSH pull; disabled until secrets exist), `backend/tools/upload_db.py` + tests, RUNBOOK sections
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

### W1 gate — security review
- [ ] one `reviewer` over B4 + app factory (auth, cookies, rate limit, headers)

### W1.5 — backend unification (owner request 2026-11-01)
- [ ] audit → `docs/v6_scoping/backend_unification.md` (duplicate currency logic, `date.today()` vs ET clock, Decimal/float, layering, tiers, duplicate helpers, naming)
- [ ] B5b one canonical EUR/USD cashflow builder with the FX-pool override map, used by metrics, periods, deposits, analytics, benchmark
- [ ] U-tasks from the audit (non-overlapping OWN lists, ≤ 4 per wave)

### W2 — frontend pages on generated types (parallel)
- [ ] G0 orchestrator: export `openapi.json`, `npm run gen:api`, write `lib/queries.ts` hooks for every endpoint
- [ ] P1 Overview (KPIs, currency-effect split, chart, allocation, movers) + Holdings
- [ ] P2 Periods + Activity + Risk + Projection/Calculator
- [ ] P3 Transactions (list + add/edit) + Import (upload → preview → confirm)
- [ ] P4 Currency conversions + Allocations/rebalance + Settings (incl. passkeys, backup) + Diagnostics + Onboarding

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
