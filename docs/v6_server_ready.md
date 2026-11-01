# Get v6 server ready

Branch `feat/v6-server-ready`. Goal: finish everything in
[`v6_one_app_plan.md`](v6_one_app_plan.md) except deleting v5, so that putting v6 on
the server is a short checklist and the owner can try it from laptop and phone first.
The server becomes the source of truth after a week of running both apps side by side.

Resume rule for any agent: read this file, then `git log --oneline main..`. Tick boxes
and add a log line as steps land. Earlier history: [`v6_progress.md`](v6_progress.md).

## Status

- [x] Wave A: parity tool, rollback kit, deploy kit, missing plan pieces
- [x] Parity baseline on a copy of the real ledger (owner reviews the differences)
- [x] Wave B: currency storage switch, Holdings polish
- [x] Wave C: layering and naming cleanup
- [x] Wave D: one ledger walk, parity rerun (owner reviews again)
- [x] Integration: full gate, local device test, PR
- [ ] Owner: server setup, upload, a week side by side, switch

## Workers (token economy: 3 contexts, reused)

| Worker | Does, in order |
| --- | --- |
| `tools` | A1, A2 |
| `app` | A3, A4, then B2 (follow-up message) |
| `core` | B1, then C1, C2, D1 (follow-up messages; one at a time) |

## Rules for every task

- Touch only your **OWN** files. Need something else? Stop and report it.
- No new dependencies (ask the orchestrator).
- **Real ledger data never enters the repo**: no account names, tickers, amounts or
  reports in commits, tests or logs. Copies and reports live in the scratch folder the
  orchestrator gives you.
- Money in `Decimal`; the currency rule in `AGENTS.md` applies.
- Every new migration has a working `downgrade()`.
- Finish green on your targeted tests (`cd backend && uv run pytest <paths> -q`;
  frontend: `npm run typecheck && npm run test` in `frontend/`) and commit only your
  files with a conventional message.

## Wave A (parallel)

### A1 Parity tool
Answers "does v6 give the same numbers as the v5.3.1 desktop app on my real ledger?"
- `backend/src/investment_dashboard/tools/parity_check.py`, three subcommands:
  - `snapshot-ledger --src <dir> --out <dir>`: copy `ledger.sqlite` + `config.sqlite`
    with the SQLite backup API (the desktop app may have them open). Read-only on the
    source.
  - `dump --ledger <dir> --out <file.json>`: open that copy (v5 tier layout) and write
    one canonical JSON of the key numbers, for `EUR` and `USD`:
    - totals: value, invested, gain, dividends;
    - returns: XIRR, TWR, YTD, MTD;
    - per instrument: shares, value, cost, gain;
    - yearly and monthly period returns;
    - deposits total.

    Uses only functions that exist in both v5.3.1 and v6. Import with a fallback:
    `readmodels.queries.X` first, else v5's `ui.pages._X`. The same file then runs
    under v5 code (`PYTHONPATH` pointed at a `legacy/v5` worktree's `src`).
  - `compare <a.json> <b.json> --out <report.md>`: tolerance 0.01 for money and 1e-6
    for ratios. List every difference. Tag the known v5 bugs (see `legacy_v5.md`,
    on branch `legacy/v5`: `docs/legacy_v5_known_bugs.md`) as "expected".
- Refuse to write any output inside the repo.
- Tests on a synthetic fixture ledger only.
- OWN: the tool file and `backend/tests/tools/test_parity_check.py`.

### A2 Rollback kit
- `backend/src/investment_dashboard/tools/export_v5_ledger.py`: v6 single DB
  (SQLCipher; key from `INV_DASHBOARD_DB_PASSPHRASE` or a hidden prompt) →
  - work on a temporary copy, `alembic downgrade` to the v5 head (`0014`);
  - split into v5's `ledger.sqlite` + `config.sqlite` (tables per tier as in
    `db.py`; cache tables dropped, v5 rebuilds them);
  - check the result opens with v5's schema;
  - write it to an output folder. Never modify the input.
- Script entry `inv-dashboard-export-v5` in `backend/pyproject.toml` (the only
  pyproject edit allowed).
- `backend/tests/test_migration_roundtrip.py`: a v5 fixture at `0014` with rows in
  every ledger/config table → `upgrade head` → `downgrade 0014`. Rows must be
  identical. Use `head` dynamically so later migrations are covered.
- Export test: fixture → v6 DB → export → identical rows.
- Runbook text goes to A3 (send it in your report).
- OWN: the tool, its test, the round-trip test, the pyproject script line.

### A3 Deploy kit and "try it first"
- One app folder everywhere: `/opt/investments`. The secrets file is
  `/opt/investments/app.env` (mode 600). Fix it in `RUNBOOK.md`, `docker-compose.yml`,
  `deploy/.env.example` and `deploy.yml`.
- `backend/.env.example`: add `INV_DASHBOARD_BACKUP_PASSPHRASE` and `INV_DASHBOARD_API_TOKEN`
  (optional, ≥ 32 chars). Comment every line. Remove `SESSION_SECRET` mentions anywhere
  in `deploy/`.
- `deploy.yml` copies `docker-compose.yml` and `Caddyfile` to the server before
  `docker compose pull`, so the server never needs a git checkout.
- `deploy/first_install.sh` (runs on the server, idempotent):
  - checks Docker, the GHCR login, `app.env` (mode, required keys present; never prints
    values) and `rclone.conf`;
  - removes `caddy-check`;
  - runs `docker compose up -d`;
  - waits for `/api/health`;
  - prints the next step, setting the password with
    `docker compose exec app inv-dashboard-set-password`.
- `deploy/check.sh` (run from the laptop, Git Bash): health, `/api/overview` returns
  401 without a session, security headers, HSTS, TLS valid. With `nmap` installed,
  only 80/443 are open.
- RUNBOOK sections, as numbered steps with exact commands:
  - "First install": secrets A–E, then `first_install.sh`, then upload.
  - "Try it before the server": copy the real ledger with
    `inv-dashboard-upload-db --local-only` (or whatever `upload_db.py` offers; add a
    local-output flag if missing, since it is OWNed here), then run
    `inv-dashboard-server` on the laptop, then `tailscale serve --bg 8000` so the phone
    opens `https://<laptop>.<tailnet>.ts.net` (passkeys need HTTPS; set
    `WEBAUTHN_RP_ID`/`ORIGIN` to that name).
  - "Rollback to v5": use A2's text.
  - "Side-by-side week": daily compare and when to switch.
- `deploy/try_local.ps1`: the "try it" steps for Windows PowerShell in one script, with
  prompts and no secrets in the file.
- OWN: `deploy/**`, `.github/workflows/deploy.yml`, `backend/.env.example`,
  `backend/src/investment_dashboard/tools/upload_db.py` + its tests.

### A4 Missing plan pieces (API + frontend)
- Activity page: each deposit shows the conversion batch(es) it was paid from and its
  effective rate, or "ECB rate" when the pool did not cover it. Uses
  `fx_conversion_service`.
- Diagnostics: a check listing deposits that fell back to the ECB rate.
- Onboarding state: `GET /api/onboarding`, returning which steps are done (account,
  first import, password/passkey, conversions, targets). The Onboarding page uses it.
- SSE: the heartbeat re-check must not extend the idle timeout. Add a non-touching
  validate path in `auth_service`, used by `api/stream.py`. Test: an open stream past
  `session_idle_minutes` gets closed.
- Regenerate `backend/openapi.json` + `frontend/src/lib/api-types.ts` at the end.
- OWN:
  - backend: `api/{deposits,diagnostics,stream,app}.py`, new `api/onboarding.py`,
    `api/schemas/{deposits,diagnostics,onboarding}.py`,
    `readmodels/{deposits,diagnostics}.py`, `services/auth_service.py`,
    `api/security.py`, plus their tests;
  - frontend: `pages/{Activity,Diagnostics,Onboarding}`,
    `lib/queries/{activity,manage}.ts` (or the files those pages use);
  - generated: `openapi.json`, `api-types.ts`.

## Parity baseline (orchestrator + owner)
1. Snapshot the OneDrive ledger into scratch. Dump it with v6 and with `legacy/v5`
   code, then compare.
2. The owner reads the report summary. Every unexpected difference is explained or
   fixed before Wave B.

## Wave B (parallel)

### B1 Currency storage switch (plan §2)
- **Snapshots** (cache tier, rebuildable):
  - `PositionSnapshot` gains `total_value_usd` + `fx_eur_usd`; `IntradayValue` gains
    `market_value_usd`.
  - Writers store native USD + the per-instant rate. Readers derive EUR as
    `usd / fx` for that instant only.
  - Migration `0017` with downgrade. Old EUR columns stay filled for one release.
- **Cashflows:** `services/cashflows.py` computes each transaction's EUR/USD from
  `net_native` + the FX table (+ pool overrides).
  - The frozen `net_eur`/`net_usd` become read-only cross-checks.
  - A Diagnostics check flags rows where frozen and derived differ by more than
    0.5 %.
  - New imports keep writing the frozen legs for one release (the v5 rollback reads
    them).
- Golden tests: an instant valuation in EUR equals `usd / fx` at that instant; XIRR in
  EUR uses each cashflow's own date's rate.
- OWN:
  - `models/{position_snapshot,intraday_value}.py`, `migrations/versions/0017_*`;
  - `services/{snapshots_service,intraday_snapshots_service,cashflows}.py`,
    `domain/currency.py`;
  - `readmodels/{live_graphs,snapshot}.py`;
  - `services/diagnostics_service.py` (new check only), plus tests.

### B2 Holdings polish (frontend only)
- Group-by (none / account / asset class / currency) with subtotals.
- A row drawer with per-instrument detail and a mini chart.
- Chart `referenceLine` prop (used for cost basis in the drawer).
- OWN: `frontend/src/pages/Holdings/**`, `frontend/src/components/Chart/**`.

## Wave C (parallel)

### C1 Layering and tiers (audit R4) + import-linter
- Move ORM queries out of services/readmodels into repositories.
- Cache-tier reads go only through their service.
- Allocation PUT updates in place (no new id).
- Add `[tool.importlinter]` contracts for the layering in `AGENTS.md`, plus a CI step
  `uv run lint-imports`.
- OWN: per audit R4 list (`docs/v6_scoping/backend_unification.md`) +
  `readmodels/allocations.py` + `backend/pyproject.toml` (`[tool.importlinter]` only) +
  `.github/workflows/ci.yml` (one step).

### C2 Shapes and naming (audit R5 rest)
- Drop the float display helpers (Decimal to the edge).
- `_eur`/`_usd` suffix naming made consistent.
- One `errors.py` module, used by the API exception handlers.
- No API shape change unless regenerated types and frontend are updated in the same
  task.
- OWN: per audit R5 list.

## Wave D

### D1 One ledger walk (audit R6)
- `services/ledger_walk.py` used by `compute_positions` and
  `compute_instrument_metrics`, which also makes multi-account instruments correct.
- A `ccy` argument on benchmark, treemap, calculator and attribution, so the USD
  benchmark is no longer blank.
- OWN: per audit R6 list.

### D2 Parity rerun (orchestrator + owner)
Same as the baseline. The only allowed differences are the ones explained earlier.

## Integration (orchestrator)

- **Full gate:** ruff, mypy domain, pytest, frontend typecheck/test/build, Playwright.
- **Local device test:** follow "Try it before the server", then click through every
  page on desktop and phone.
- **Docs:** `docs/architecture.md` describes v6; this file and the plan status line
  are updated.
- **Changelog and PR:** CHANGELOG, then the PR.
- **Release:** a `6.0.0-rc` release is the owner's call.

## Owner checklist (after the PR)

1. Try it locally on laptop and phone (RUNBOOK "Try it before the server").
2. Server: secrets A–E, `first_install.sh`, set the password, add passkeys, upload the
   ledger, `deploy/check.sh`, a restore drill.
3. A week side by side: compare totals daily (the parity tool works on the server copy
   too).
4. Switch: import only on the server from then on. Keep a sealed copy of the final v5
   ledger. Rolling back uses `inv-dashboard-export-v5`.
5. Later, at cutover: delete v5 code, switch off GitHub Pages, the Worker and the
   Twelve Data key, archive the plaintext OneDrive ledger, release 6.0.0.

## Log
- 2026-11-01 plan written; branch created.
- 2026-11-01 A1+A2 done (c37f774). Parity baseline (as of 2026-10-30, `main` vs v5.3.1, 18 instruments, 43 months): 2 differences, both the known v5 Analytics-USD bug (USD analytics XIRR and TWR); everything else identical. B1 part 1 (cashflows, migration 0017 `f4c8d6e0a3b2`) in 1e48559; writers/readers in progress.
- 2026-11-01 A3 (cf89dfc) + A4 (216a955) done; runbook rollback filled (c6b2f21). B1 done (952193f): parity main vs branch 0 differences. Running: core C1, app B2. Gate todo: CHANGELOG entries, ruff SIM102 in parity_check.py, stray ruff reformat of untracked files.
- 2026-11-01 B2 (96e814e, 2dd0f05 price history), C1 (3bf29b0, 9c86abc), C2 part (dd670cc), D1 (a4e5b5b, b90b660). Parity after D1: 0 differences vs main; vs v5 only the Analytics-USD fix. Deferred with reason: TierSessions/_context rework (contract change; single DB on the server), float display helpers (v5 ui only, go at cutover), `_eur`/`_usd`/`*_pct` renames (API churn), calculator ccy (no number changes).
- 2026-11-01 Integration: merged main (#326). Full gate green: ruff, mypy, lint-imports, 1952 backend tests (3 known laptop-only failures), 62 frontend tests, build, Playwright 3/3. Local trial on the real ledger copy: login, all endpoints 200, Holdings drawer chart, Diagnostics all clear. Fixed during the trial: CSP blocked the inline theme script; Windows has no SQLCipher driver, so the laptop trial uses `--plain`. Dependabot minimatch alert fixed via npm override.
