# Agent guide — read first

This file is the **single source of truth** for project rules.
`.github/copilot-instructions.md` and `CLAUDE.md` only point here; `CONTRIBUTING.md`
covers dev setup. If another doc disagrees with this file, this file wins — fix the
other doc.

## Project status: v5 → v6

- **v5 (current code):** a local NiceGUI desktop app plus a read-only web companion
  (`web/`) fed by an encrypted GitHub-release blob.
- **v6 (planned):** one hosted FastAPI backend + React frontend. The plan is
  [`docs/v6_one_app_plan.md`](docs/v6_one_app_plan.md). Do not start a v6 phase
  until the owner has approved it; keep v5 working until cutover.
- **Legacy:** branch `legacy/v5` / tag `v5.3.1` is frozen. Never commit to it or
  backport to it (the owner-requested known-bugs note there is the only exception);
  see [`docs/legacy_v5.md`](docs/legacy_v5.md).
- **Where v6 stands:** the plan's status line (top of `docs/v6_one_app_plan.md`) is
  the source of truth; keep it current when a phase step finishes.

## Stack at a glance

| | Now (v5, this code) | Target (v6, see plan §4 / §4a) |
| --- | --- | --- |
| Backend | Python 3.12, NiceGUI on FastAPI/uvicorn, SQLAlchemy 2 + Alembic, SQLite (ledger / config / cache tiers), pandas/numpy/scipy, yfinance + Frankfurter (+ Tiingo fallback), `uv` | Same Python core as a FastAPI API server in `backend/`, SQLCipher, server-side scheduler, SSE |
| Frontend | `web/`: Vite + vanilla TypeScript PWA on GitHub Pages, reads an encrypted blob | `frontend/`: React 19 + TS + Vite, SCSS/BEM tokens, TanStack Query |
| Hosting | Owner's laptop (LAN) + GitHub Pages + Cloudflare Worker | One Docker Compose stack (app + Caddy + rclone backup sidecar; sealed SQLCipher snapshots, no Litestream) on the Hetzner server |
| Docs | [`docs/architecture.md`](docs/architecture.md) | [`docs/v6_one_app_plan.md`](docs/v6_one_app_plan.md), [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) |

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
- **v5 transition:** transactions still store frozen `net_eur` / `net_usd` /
  `fx_rate_to_eur` legs, and `PositionSnapshot` / `IntradayValue` store a EUR pivot
  with per-instant FX. Leave them working until the v6 currency migration
  (plan §2); do **not** add new derived-currency columns.
- `Decimal` end to end; round only for display.

## Architecture rules

- Layering: `ui`/`api` → `services` / `readmodels` → `repositories` / `adapters` → `domain`.
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
- **Strong server, weak client:** business maths, market-data provider calls and
  secrets belong in the backend. The v5 web companion still contains some of this;
  don't add more.
- Secrets never go in the repo. Settings are documented in `.env.example` files
  (v6); real `.env` files are git-ignored.

## v6 structure and style (applies to new v6 code)

Adapted from the owner's starter-project convention (see plan §4a):

- Top level: `backend/`, `frontend/`, `deploy/`, `docs/`. The Python project already
  lives in `backend/` (run `uv` and `pytest` from there); `web/` moves to `frontend/`
  at the start of v6 Phase 1.
- Backend: one router module per resource in `api/`, mounted under `/api`;
  settings via pydantic-settings (`config.py`, cached `get_settings()`).
- Frontend: TypeScript; `components/<Name>/` and `pages/<Name>/` each hold
  `<Name>.tsx` + `<Name>.scss` + `index.ts`; non-UI helpers in `lib/`.
- Styling: co-located SCSS with **required BEM** class names
  (`.block__element--modifier`); colors, sizes, spacing and radii only from
  `var(--…)` tokens in `styles/tokens.scss`. No bare element selectors or generic
  classes inside component stylesheets.

## Testing

- New money maths in `domain/` gets **property tests** (`hypothesis`) plus golden
  values checked by hand or against the source spreadsheet.
- Adapters are tested with mocked HTTP (`respx`) or patched downloaders. Live-API
  tests are `@pytest.mark.network` and skipped unless `--run-network`.

## Workflow

- **Git flow:** features and risky changes go through a PR. Small or urgent fixes
  may be pushed straight to `main` once the quality gate passes. `main` must stay
  green (in v6 every green `main` commit deploys).
- **Changelog:** every change adds a `CHANGELOG.md` entry (Keep a Changelog
  sections; small UI updates and patch-sized changes go under **Fixed**).
- **Release fast — default is one release per change.** Any change that alters
  what the app does (feature or bug fix) is released **in the same PR/push**: a
  patch bump for fixes, a minor bump for features, under a dated
  `## [x.y.z] — YYYY-MM-DD` heading. Bump `backend/pyproject.toml` and `web/package.json`
  in lockstep and regenerate lockfiles (`uv lock`, and `npm install` inside
  `web/`). Pushing the bump to `main` tags the release.
- **`[Unreleased]` is temporary storage, not the default.** Use it only for
  changes with no effect on the running app (docs, CI, tests, refactors) or to
  batch a short series of related PRs. Fold it into the next release; no entry
  should sit there longer than a few days, and **a bug fix never waits there**.
- **Quality gate** before handoff (CI runs the same). The full local `pytest`
  run takes about 2 hours on the owner's laptop (CI: about 2 minutes), so run the
  targeted tests for what you touched locally and let CI run the full suite. Known
  laptop-only failures (they read the real keyring and Dropbox/OneDrive folders):
  `tests/storage/test_cloud_and_paths.py` cloud-detection tests and
  `tests/services/test_publish_service.py::test_publish_now_requires_repo_passphrase_token`.
  - From `backend/`:
  - `uv run ruff format .`
  - `uv run ruff check . --fix`
  - `uv run mypy src/investment_dashboard/domain`
  - `uv run pytest`
  - `npm run typecheck` and `npm run test` inside `web/`
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`), subject ≤ 72 chars.
- On completion, open/update the PR that contains the work; at the very end, check
  for conflicts with `main` and resolve them before handoff.
