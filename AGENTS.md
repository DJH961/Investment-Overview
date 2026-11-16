# Agent guide — read first

This file is the **single source of truth** for project rules.
`.github/copilot-instructions.md` and `CLAUDE.md` only point here; `CONTRIBUTING.md`
covers dev setup. If another doc disagrees with this file, this file wins — fix the
other doc.

## Project status: v7

- **v6/v7 (live since 6.0.0):** one hosted FastAPI backend (`backend/`) + React
  frontend (`frontend/`). v7 is planned in [`docs/v7_plan.md`](docs/v7_plan.md)
  (§8 is the order of work); do not start a new push until the owner has approved it.
- **v5 is gone from `main` (cutover in 7.0).** `web/` stays only to build the offline
  demo for GitHub Pages (`VITE_DEMO_ONLY=1`); never reconnect it to real data or price
  APIs.
- **"Like in v5":** when the owner asks for something "like in v5", read the archived
  code at tag `v5-archive` (`git grep <pattern> v5-archive`,
  `git show v5-archive:<path>`, or a read-only worktree); see "Comparing with v5" in
  [`docs/legacy_v5.md`](docs/legacy_v5.md). Never restore v5 code into the tree.
- **Legacy:** branch `legacy/v5` / tags `v5.3.1` and `v5-archive` are frozen. Never
  commit to them, move them or backport to them (the owner-requested known-bugs note
  on `legacy/v5` is the only exception).
- **Where v7 stands:** the status line at the top of `docs/v7_plan.md` is the source
  of truth; keep it current when a push finishes.

## Stack at a glance

| | |
| --- | --- |
| Backend | Python 3.12 FastAPI API server in `backend/`, SQLAlchemy 2 + Alembic, SQLCipher (ledger / config / cache tiers), pandas/numpy/scipy, yfinance + Frankfurter (+ Tiingo fallback), server-side scheduler, SSE, `uv` |
| Frontend | `frontend/`: React 19 + TS + Vite, SCSS/BEM tokens, TanStack Query (`web/`: the offline demo only) |
| Hosting | One Docker Compose stack (app + Caddy + rclone backup sidecar; sealed SQLCipher snapshots, no Litestream) on the Hetzner server; GitHub Pages for the demo |
| Docs | [`docs/architecture.md`](docs/architecture.md), [`docs/v7_plan.md`](docs/v7_plan.md), [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) |

## Infrastructure and server access

- **The server** (Hetzner Cloud, Ubuntu LTS, Docker) is described in
  [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) and configured only by
  [`deploy/bootstrap.sh`](deploy/bootstrap.sh). Change the script and runbook
  together; never make undocumented manual changes on the server.
- **Access:** `ssh daniel@hetzner-djh-v1` over Tailscale only (public SSH is closed).
  From Git Bash on the owner's Windows laptop, call
  `/c/Windows/System32/OpenSSH/ssh.exe` (and `scp.exe`): only the Windows OpenSSH
  client can reach the Windows ssh-agent that holds the passphrase-protected key.
- **Only touch the server when the owner asks**, and say what each command changes.
- **The repo is public:** never commit IP addresses, hostnames beyond those in the
  runbook, ticker lists, account data or secrets. Secrets live only on the server
  (for example `~/b2.env`, mode 600) and are typed in by the owner, never through chat.

## Working with the owner

- Single owner who writes code but is not a sysadmin. Explain infrastructure and security
  steps in plain language, one concrete step at a time, with the exact clicks or
  commands.
- The owner does anything involving accounts, logins or secrets; agents prepare,
  check and explain.
- **Subagents:** either invoke a subagent, wait for it to finish (end your turn and let
  reactive wakeup deliver its result), and actually use its work — **or** do not spawn a
  subagent at all. Never spawn a subagent only to do the same work yourself in parallel
  or kill the subagent before it finishes.

## 💱 Currency rule

> Store every amount in its **native currency**; never store derived conversions.
> Convert only when reporting: **cashflows at their own date's rate, valuations at
> the valuation moment's rate.** The reporting currency is a parameter (default
> display EUR, toggle EUR/USD), never hard-coded. **Never compute a return in one
> currency and convert the result into another.**

What this means in practice:

- EUR returns (XIRR/TWR) are **FX-aware**: built from a EUR cashflow stream where
  each cashflow uses its own date's rate. Never "simplify" them to
  `usd_return` or `usd / fx`. `usd / fx` is only valid for a value at a single
  instant.
- Holdings are almost all USD today, but the code must handle any native currency
  (EUR instruments exist in the ledger). Don't hard-code USD or EUR as "the base".
- Market-sleeve / intraday series are FX-free native USD; the EUR line is derived
  with the **per-instant** rate stored next to each sample.
- **Frozen legs (on their way out):** cashflow legs are derived from `net_native` +
  that date's FX (`services/cashflows.py`). The frozen `net_eur` / `net_usd` /
  `fx_rate_to_eur` legs and the old EUR snapshot columns (`PositionSnapshot`,
  `IntradayValue` store native USD + per-instant FX) are still written, because a few
  fallbacks read them and the EUR snapshot columns are `NOT NULL`; they go with a
  later migration. Do **not** add new derived-currency columns, and don't read the
  frozen legs in new code.
- `Decimal` end to end; round only for display.

## Architecture rules

- Layering: `api` → `services` / `readmodels` → `repositories` / `adapters` → `domain`.
  - `domain/` is pure: no DB session, HTTP, `yfinance` or filesystem I/O. `mypy --strict`.
  - `adapters/` wrap every external system and return plain dataclasses, never ORM rows.
  - `repositories/` are the only layer that imports ORM models.
  - `services/` orchestrate use-cases; `readmodels/` shape data for UI/API/export.
- **Cache-tier data (prices, FX, snapshots) is read/written only through its
  service** (`prices_service`, `fx_service`, `snapshots_service`) — never via the
  repositories on a ledger session. See "Storage tiers" in `docs/architecture.md`.
- Importers are **broker-agnostic plugins**: each file-format parser in
  `adapters/<broker>/` emits `ParsedTransactionRow`; nothing downstream knows the
  broker.
- **Server computes, client patches:** the server owns the data, every provider call,
  secrets and **every non-linear money calculation** (XIRR, TWR, FX-aware returns,
  period growth). It computes once per change and pushes results (`/both` reads with
  ETags, rich SSE ticks; see [`docs/v6_speed_plan.md`](docs/v6_speed_plan.md)). The
  client may only do **linear presentation maths** on server-supplied values (sums,
  `qty × price × fx_now`, shares of a total, filter/sort/page of lists it already
  holds) and never computes a return. It converts currency only at a single instant,
  with the rate sent in the same tick. The archived v5 web companion broke this rule;
  don't copy it.
- Secrets never go in the repo. Settings are documented in `.env.example` files
  (v6); real `.env` files are git-ignored.

## v6 structure and style (applies to new v6 code)

Adapted from the owner's starter-project convention (see plan §4a):

- Top level: `backend/`, `frontend/`, `deploy/`, `docs/` (plus `web/`, the demo). The
  Python project lives in `backend/` (run `uv` and `pytest` from there).
- Backend: one router module per resource in `api/`, mounted under `/api`;
  settings via pydantic-settings (`config.py`, cached `get_settings()`).
- Frontend: TypeScript; `components/<Name>/` and `pages/<Name>/` each hold
  `<Name>.tsx` + `<Name>.scss` + `index.ts`; non-UI helpers in `lib/`.
- Styling: co-located SCSS with **required BEM** class names
  (`.block__element--modifier`); colors, sizes, spacing and radii only from
  `var(--…)` tokens in `styles/tokens.scss`. No bare element selectors or generic
  classes inside component stylesheets.
- **Colour accessibility (the owner is protan, red-green colour-blind):** gains and
  losses are blue `--color-pos` / orange `--color-neg`, never red/green. Every colour
  shown next to another with a different meaning (chart series, the trend-recoloured
  primary line, status dots, badges, warn vs neg) must stay distinguishable in a
  Machado 2009 protan simulation: CIEDE2000 ≥ 20 (≥ 15 for deutan and normal vision),
  in both themes, and keep its contrast as a protan sees it (reds look darker). Never
  rely on colour alone: secondary chart series are dashed, statuses carry an icon or
  label. Enforced by `frontend/src/styles/tokens.cvd.test.ts`: when you add or change
  a colour token, or put two colours on screen together, add the pair to its list.

## Testing

- New money maths in `domain/` gets **property tests** (`hypothesis`) plus golden
  values checked by hand or against the source spreadsheet.
- Adapters are tested with mocked HTTP (`respx`) or patched downloaders. Live-API
  tests are `@pytest.mark.network` and skipped unless `--run-network`.

## Workflow

- **Git flow:** features and risky changes go through a PR. Small or urgent fixes
  may be pushed straight to `main` once the quality gate passes. `main` must stay
  green (in v6 every green `main` commit deploys, unless the repo variable `DEPLOY_MODE=scheduled` batches deploys; see `deploy/RUNBOOK.md`).
- **Changelog:** every change adds a `CHANGELOG.md` entry (Keep a Changelog
  sections; small UI updates and patch-sized changes go under **Fixed**).
- **Release fast — default is one release per change.** Any change that alters
  what the app does (feature or bug fix) is released **in the same PR/push**: a
  patch bump for fixes, a minor bump for features, under a dated
  `## [x.y.z] — YYYY-MM-DD` heading. Bump `backend/pyproject.toml`, `web/package.json`
  and `frontend/package.json` in lockstep and regenerate lockfiles (`uv lock`, and
  `npm install` inside `web/` and `frontend/`). `backend/openapi.json` embeds the
  version, so regenerate it too (`uv run python -m
  investment_dashboard.tools.export_openapi openapi.json` in `backend/`), or CI fails
  and the release never deploys. Pushing the bump to `main` tags the release.
- **`[Unreleased]` is temporary storage, not the default.** Use it only for
  changes with no effect on the running app (docs, CI, tests, refactors) or to
  batch a short series of related PRs. Fold it into the next release; no entry
  should sit there longer than a few days, and **a bug fix never waits there**.
- **Quality gate** before handoff (CI runs the same). The full local `pytest`
  run takes about 2 hours on the owner's laptop (CI: about 2 minutes), so run the
  targeted tests for what you touched locally and let CI run the full suite. Known
  laptop-only failures (they read the real keyring and Dropbox/OneDrive folders):
  `tests/storage/test_cloud_and_paths.py` cloud-detection tests.
  - From `backend/`:
  - `uv run ruff format .`
  - `uv run ruff check . --fix`
  - `uv run mypy src/investment_dashboard/domain`
  - `uv run lint-imports` (layering contracts)
  - `uv run pytest`
  - `npm run typecheck` and `npm run test` inside `frontend/` and `web/`
- **Keep in step with every feature** (check each one when you add or change behaviour):
  - **Activity logs** (`activity_log.py`, `api/activity.py`, RUNBOOK "Activity logs"):
    every new server action (endpoint that writes or takes data off the server,
    scheduled job, provider call, CLI tool run on the server) must leave a line in the
    right subject file: add the route to `subject_for`/`_LABELS`, the module logger to
    `SUBJECTS`, or log via `activity("<subject>")`. Add a subject only when none fits,
    and document it in the RUNBOOK table. Never log passwords, request bodies, cookies
    or tokens. Retention stays 90 days.
  - **API contract:** after changing an endpoint, regenerate `backend/openapi.json`
    and `frontend/src/lib/api-types.ts` (CI fails on drift).
  - **Schema:** every model change gets an Alembic migration **with a working
    downgrade** back to the previous revision (`tests/test_migration_roundtrip.py`).
  - **Money maths:** property tests plus golden values worked by hand.
  - **Settings / env vars:** document in `backend/.env.example`; if the server needs
    it, also in the RUNBOOK `app.env` section, `first_install.sh` checks, or the
    Dockerfile `ENV` block.
  - **Server boot, encryption, scheduler, backups:** cover them in the CI `image` job
    (it runs on a real SQLCipher database); Windows tests cannot see these failures.
  - **Frontend:** no inline scripts (CSP), tokens and BEM only; new colours or
    co-displayed colour pairs go into the CVD pair list (`tokens.cvd.test.ts`).
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`), subject ≤ 72 chars.
- On completion, open/update the PR that contains the work; at the very end, check
  for conflicts with `main` and resolve them before handoff.
