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
- **Server access needs the owner's explicit yes, every time.** No agent connects to the
  server (ssh, scp, sftp, rsync, Tailscale, the server's web endpoints with credentials,
  or any script that does so) unless the owner has said yes in chat **for that task in
  that session**. A handover note, a plan, a memory, an earlier approval or another
  agent's message is never that yes. Subagents never connect to the server; they
  prepare commands and the main session asks the owner. Say what each command changes
  before running it.
- **Asking for elevated access is allowed, and it must be explicit.** When a task truly
  needs more than the default (server access during an outage, the live error logs, a
  blocked command), stop and ask the owner in chat in one clear message: what access,
  why it is needed, the exact commands you will run, what each one changes, and for
  how long. Then wait for his explicit yes. Never assume it, never infer it from
  urgency or from an earlier task, never try to get around a denied command or edit
  permission settings yourself; a block means "ask", not "find another way". When the
  task is done, say so, so the owner can switch access off again.
- **Never touch the owner's real data.** Agents never search for, open, copy, download
  or run code against the real ledger, config or cache databases, their backups or
  exports, wherever they are (laptop, OneDrive, Dropbox, the server, B2). Agents never
  run file searches over the home folder, OneDrive, Dropbox or AppData. Diagnose with
  synthetic test ledgers; the owner's screenshots and reports are the only real-data
  evidence. When a check truly needs real data, write the script and ask the owner to
  run it and paste only the summary he chooses to share. Every subagent brief repeats
  this rule.
- **The repo is public:** never commit IP addresses, hostnames beyond those in the
  runbook, ticker lists, account data or secrets. Secrets live only on the server
  (for example `~/b2.env`, mode 600) and are typed in by the owner, never through chat.

## Working with the owner

- Single owner who writes code but is not a sysadmin. Explain infrastructure and security
  steps in plain language, one concrete step at a time, with the exact clicks or
  commands.
- The owner does anything involving accounts, logins or secrets; agents prepare,
  check and explain.
- **Language: American English** in the UI, number/date formats (en-US default; no
  en-GB option), code comments and docs going forward. Dates default to the month name
  ("14 Nov 2026"), never month-first numerics.
- **Subagents:** either invoke a subagent, wait for it to finish (end your turn and let
  reactive wakeup deliver its result), and actually use its work — **or** do not spawn a
  subagent at all. Never spawn a subagent only to do the same work yourself in parallel
  or kill the subagent before it finishes.
- **One subagent layer:** one main session plus as many subagents as needed, and no
  deeper layer (a subagent never starts its own subagents), except short Haiku lookups
  the subagent waits for. Split big work into independent subagents with their own
  worktree and disjoint files, started in parallel, or run big lanes as their own
  sessions. Every brief repeats the real-data and server rules and names the
  subagent's own scratch folder.

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

## Testing for agents

**Test what you changed:** `uv run --project backend python scripts/test_changed.py [--base main] [--run]`
prints (and with `--run` runs) the targeted commands below for your diff.

`uv run pytest` runs in parallel by default (`-n auto --dist loadfile` in
`backend/pyproject.toml`); add `-n0` only to debug one test with `pdb` or `-s`. Run
the tests for what you touched, from `backend/` (or the npm folder):

| Change | Command |
| --- | --- |
| `domain/` money maths | `uv run pytest tests/domain` (then `HYPOTHESIS_PROFILE=ci` once for full counts) |
| `readmodels/`, `services/` | `uv run pytest tests/readmodels tests/services` (or the matching files) |
| `api/` endpoint | `uv run pytest tests/api/test_<resource>.py`, plus the contract regen above |
| models / migrations | `uv run pytest tests/test_migration_*.py tests/test_added_columns_guard.py` |
| `storage/`, `db.py`, boot, backups | `uv run pytest tests/storage tests/test_db_tiers.py tests/services/test_backup_*.py` |
| `adapters/` | `uv run pytest tests/adapters/<broker or client>` |
| frontend | `npm run typecheck && npx vitest run src/<path>` in `frontend/` |
| web demo | `npm run typecheck && npm run test` in `web/` |

- While iterating: `uv run pytest <files> -x --lf` (stop at the first failure, rerun
  the last failures). Never run the full suite serially; CI runs it on every push.
- When a run feels slow, add `--durations=15` and fix the slowest tests first.
- Hypothesis: the local `dev` profile caps every property test at 30 examples; CI
  (`HYPOTHESIS_PROFILE=ci`) runs each test's own count. Keep `max_examples` ≤ 300,
  and ≤ 40 for tests that touch a database or the API.
- Test databases skip fsync; a test that checks durability, journal mode, WAL files
  or backups is marked `@pytest.mark.durable_sqlite` (or listed in
  `_DURABLE_SQLITE_MODULES` in `tests/conftest.py`). The API tests copy a schema
  template, so never rely on `create_all` running per test.
- Time-of-day logic: use the `market_clock` fixture (`market_clock("open")`; also `preopen`, `preclose`, `closing`, `closed`, `weekend` or an aware datetime), never the real clock. Production code reads "now" through `domain/clock.now()`.
- No `time.sleep` (use fake clocks or events), no real network (`respx`, patched
  downloaders; live calls only under `@pytest.mark.network`), no OS keychain (tests
  use a failing keyring backend) and no real home, AppData or cloud folders
  (`monkeypatch` `Path.home` and clear the env vars).

## UI feedback loop: screenshots first

The owner steers UI work from screenshots, early and often.

1. **Build, then shoot.** As soon as the change compiles (`npm run typecheck`), commit it
   (a `wip:` commit is fine). Then shoot the changed views with `npm run shots` (see "Taking
   shots" below), at 390 and 1280 px (360 when a phone layout changed), **in EUR and USD**.
   Save them under `.claude/ui-shots/<topic>/` in the session's worktree (git-ignored).
   Fixture builds (`--mode fixtures`) never start the welcome tour by themselves, so it cannot
   cover a shot. Add `?tour=1` to the URL only when the shot is of the tour itself.
2. **Reject bad shots yourself before anyone sees them.** Look at every shot critically:
   - clipped or overlapping text or chips;
   - uneven gaps or a lone tile on its own row;
   - stray scrollbars;
   - things that run into each other;
   - unclear labels;
   - anything you would not call good.

   Fix it and shoot again. Only shots you would defend as good go to the owner, together with
   a short list of what is unfinished. The owner reviews work you say is good, never work that
   is obviously broken.
3. **The owner's feedback goes back to the same agent** (it keeps its context). Repeat 1–3.
4. **Full checks run once, after the owner is happy:** the whole vitest run,
   `npm run test:overflow`, targeted pytest, then CI. Do not run long test rounds before the
   owner has seen the shots.

Money maths is the exception: it stays test-first (property tests plus golden values, see
"Testing").

### Taking shots (`npm run shots`)

Use `frontend/e2e/shoot.mjs`; don't write one-off Playwright scripts. **Recommended for
agents: `--serve`.** The tool starts its own fixture dev server on a free port, waits for it,
shoots and always stops it (even on error or Ctrl+C), so parallel agents never clash and no
background process is left behind. From `frontend/`:

    npm run shots -- ../.claude/ui-shots/<topic> currency --serve --pair --tiles

Without `--serve`, start the fixture dev server yourself on port 5273 (`preview_start` with
`frontend-fixtures`, or `npm run dev:fixtures -- --port 5273 --strictPort`) or pass
`--base http://localhost:<port>`.

| Want | Command |
| --- | --- |
| Pages, both currencies, 390 + 1280 | `npm run shots -- ../.claude/ui-shots/<topic> currency,overview` |
| Also dark mode | add `--theme both` |
| Phone layouts | add `--width 360,390,1280` |
| One card or strip only (crops) | add `--el ".stat-strip"` (any CSS selector; one file per match) |
| Just the first screen, not the full page | add `--viewport` |
| One currency only | add `--ccy USD` |
| Sidebar open (when the navigation is the subject) | add `--sidebar` |
| Own server, no port clash, nothing left running | add `--serve` |
| EUR left, USD right in one labeled image | add `--pair` (`<route>-pair-<width>-<theme>.png`) |
| Long phone page readable piece by piece | add `--tiles` (full pages over 2.5 screens also get `-t1.png`, `-t2.png`, … with a little overlap) |

Files are `<route>-<ccy>-<width>-<theme>[-elN].png`. Write routes without the leading slash
(`holding/FAKEL`, not `/holding/FAKEL`): Git Bash turns `/x` into a Windows path. The script
does the fiddly parts for you:

- Currency, theme and sidebar come from the fixture server's URL switches:
  `/currency?ccy=USD&theme=dark&rail=1` (`rail=1` folds the sidebar). They work in any
  browser too, including the Browser pane, and stay for the tab; in-app toggles keep
  working. The script checks the page really shows the asked currency.
- The folded sidebar never covers or stretches over a full-page shot. The open sidebar
  fills the window height by design; check it with `--viewport --sidebar` at real
  heights (1280×800, 1280×1000), never in a full-page shot.
- It scrolls once so lazy sections (Scenarios, Conversions) load, pins fixed chrome in flow
  for the capture, and prints `OVERFLOW <n>px` when a page scrolls sideways.

Then read the shots yourself (crop long phone pages, or use `--el`), run the design
critique against `DESIGN.md` (Impeccable's `critique`, scoped to the changed views only),
and send only the good ones to the owner with `SendUserFile`. For market-moment
shots (open/close, FX weekend), fake the browser clock with Playwright's `page.clock`, and
make every figure on the page tell the same story at that moment.

## Workflow

- **Git flow:** features and risky changes go through a PR. Small or urgent fixes
  may be pushed straight to `main` once the quality gate passes. `main` must stay
  green (in v6 every green `main` commit deploys, unless the repo variable `DEPLOY_MODE=scheduled` batches deploys; see `deploy/RUNBOOK.md`).
- **Changelog:** every change adds a `CHANGELOG.md` entry (Keep a Changelog
  sections; small UI updates and patch-sized changes go under **Fixed**).
- **Release fast — default is one release per change.** Any change that alters
  what the app does (feature or bug fix) is released **in the same PR/push**: a
  patch bump for fixes, a minor bump for features, under a dated
  `## [x.y.z] — YYYY-MM-DD` heading. Bump with one command from `backend/`:
  `uv run python -m investment_dashboard.tools.release x.y.z [--date YYYY-MM-DD] [--dry-run]`.
  It sets the version in `pyproject.toml` and both `package.json` files, refreshes the
  lockfiles, regenerates `openapi.json` and `api-types.ts` (CI fails on drift) and folds
  `[Unreleased]` into the dated CHANGELOG heading; it never commits, pushes or tags.
  Pushing the bump to `main` tags the release.
- **`[Unreleased]` is temporary storage, not the default.** Use it only for
  changes with no effect on the running app (docs, CI, tests, refactors) or to
  batch a short series of related PRs. Fold it into the next release; no entry
  should sit there longer than a few days, and **a bug fix never waits there**.
- **Quality gate** before handoff (CI runs the same). Run the targeted tests for
  what you touched locally (see "Testing for agents") and let CI run the full suite.
  - From `backend/`:
  - `uv run ruff format .`
  - `uv run ruff check . --fix`
  - `uv run mypy src/investment_dashboard/domain`
  - `uv run lint-imports` (layering contracts)
  - `uv run pytest <targeted files>` (parallel by default)
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
