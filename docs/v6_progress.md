# v6 implementation progress (resume file)

Living checklist for the v6 build on branch `feat/v6-one-app`. Any agent picking
this up after an interruption: read this file first, then `git log --oneline main..`.
Tick boxes and append to the log as steps land; commit this file with each step.

The plan ([`v6_one_app_plan.md`](v6_one_app_plan.md)) is the direction; this file is
the execution order, which deliberately differs from the plan's phase numbering.

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

## Waves

### W0 — restructure + frontend foundation (parallel)
- [ ] T0 `git mv` src/tests/migrations/pyproject/uv.lock/alembic.ini → `backend/`; fix CI, launchers, installer, tools, pre-commit, path-reading tests; move `ui/pages/_*_query.py` logic into `readmodels/queries/` with re-export shims
- [ ] T1 `frontend/` foundation: Vite + React 19 + TS, oxlint, tokens/SCSS, responsive app shell, component kit, Chart component, login page, PWA, Vitest

### C1 — contracts (orchestrator)
- [ ] `config.py` v6 settings, `api/app.py` factory skeleton, `api/deps.py`, router stubs, migration revision ids

### W1 — backend features + deploy (parallel)
- [ ] T2 read/write/import/ops routers + Pydantic schemas + SPA static serving + `tests/api/` + OpenAPI export
- [ ] T3 auth: argon2 password, passkeys (webauthn), sessions cookie, rate limit, idle timeout, bearer token kept, `set-password` CLI
- [ ] T4 currency: `domain/fx_pool.py` (hypothesis), `fx_conversions` model/migration/repo/service/router, deposit matching + diagnostics
- [ ] T5 scheduler (lifespan) + SSE live bus + `/api/stream`
- [ ] T6 deploy: multi-stage Dockerfile, compose (app+Caddy+Litestream), Caddyfile, deploy workflow, `upload_db.py`, `.env.example`, runbook

### W2 — frontend pages (parallel)
- [ ] OpenAPI → `frontend/src/lib/api-types.ts`
- [ ] T7 read pages: Overview, Holdings, Periods, Activity, Risk, Calculator, live SSE
- [ ] T8 write pages: Import, Transactions, Currency conversions, Allocations, Settings (passkeys, backup), Diagnostics, Onboarding

### W3 — integration
- [ ] full gate green, CI frontend job, Playwright smoke, CHANGELOG, plan status line, PR

## Owner-input items (not done by agents)
- yfinance spike (Mon 2026-11-02) — still to run.
- Parity gate on the real ledger → then the snapshot/intraday storage migration.
- Set `DB_KEY`, `SESSION_SECRET`, `TIINGO_TOKEN`, `B2_*` on the server; GHCR + Actions secrets.
- Run `upload_db.py` with the real ledger; restore drill; first deploy.

## Log
- 2026-10-31 branch created, tracker written.
