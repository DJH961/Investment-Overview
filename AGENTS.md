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

- Top level: `backend/`, `frontend/`, `deploy/`, `docs/`. The move from `src/` and
  `web/` happens in one `git mv` commit at the start of v6 Phase 1.
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
- **Changelog:** every change adds an entry under `## [Unreleased]` in
  `CHANGELOG.md` (Keep a Changelog sections; small UI updates and patch-sized
  changes go under **Fixed**).
- **Releases:** bump the version only when cutting a release — rename
  `[Unreleased]` to `## [x.y.z] — YYYY-MM-DD`, bump `pyproject.toml` and
  `web/package.json` in lockstep, and regenerate lockfiles (`uv lock`, and
  `npm install` inside `web/`). Pushing the bump to `main` tags the release.
- **Quality gate** before handoff (CI runs the same):
  - `uv run ruff format .`
  - `uv run ruff check . --fix`
  - `uv run mypy src/investment_dashboard/domain`
  - `uv run pytest`
  - `npm run typecheck` and `npm run test` inside `web/`
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`), subject ≤ 72 chars.
- On completion, open/update the PR that contains the work; at the very end, check
  for conflicts with `main` and resolve them before handoff.
