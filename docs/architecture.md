# Architecture

How the system is put together. Two apps share one Python core in `backend/` until
cutover: the **v6 server** (FastAPI API + React frontend, hosted) and the **v5 desktop
app** (NiceGUI, `ui/`). The rules that govern the code (layering, cache-tier access,
currency) live in [`../AGENTS.md`](../AGENTS.md); the original requirements are in
[`original_spec.md`](original_spec.md); the v6 plan is
[`v6_one_app_plan.md`](v6_one_app_plan.md) and the server runbook
[`../deploy/RUNBOOK.md`](../deploy/RUNBOOK.md).

## v6 server at a glance

```
browser (React, frontend/) ──HTTPS──► Caddy ──► app container: FastAPI (api/app.py)
                                                  ├─ /api/*   one router per resource (auth-guarded)
                                                  ├─ /        built React app (SPA fallback)
                                                  ├─ scheduler (services/scheduler.py): quotes + FX
                                                  │   every 60 s in market hours, EOD jobs, backups
                                                  └─ /data/app.sqlite (SQLCipher, all tiers in one file)
backup sidecar (rclone) ── copies sealed snapshots ──► Backblaze B2 (append-only)
```

- **Contract:** Pydantic response models → committed `backend/openapi.json` →
  generated `frontend/src/lib/api-types.ts` (CI fails on drift). Decimals travel as
  strings; ratios are fractions (`*_pct`, 0.01 = 1 %).
- **Auth:** argon2 password + passkeys, server-side sessions in a `__Host-` cookie,
  Origin check on writes, login rate limit; optional bearer token for scripts.
- **Live:** `services/live_bus.py` → SSE `/api/stream`; the browser never calls a
  market-data provider.
- **Rollback:** every v6 migration has a working downgrade to v5's head (`0014`,
  tested in CI); `inv-dashboard-export-v5` turns the server DB back into v5 files.
- **Layering is enforced** by `import-linter` (`[tool.importlinter]` in
  `backend/pyproject.toml`, `uv run lint-imports` in CI).

## Goal

A local-first, single-user investment dashboard whose ground truth is a
**transaction ledger**, with rich return metrics in **USD and EUR**, reachable from
any device on the user's LAN. A read-only, encrypted web companion (`web/`) gives a
phone view from a published snapshot.

## Layered structure

```
ui/         NiceGUI pages (v5 only).            Thin: input -> service -> render.
api/        v6 FastAPI routers + schemas.       Thin wrappers over readmodels/services.
services/   Use-case orchestration.             Composes domain + adapters + repos.
readmodels/ UI-agnostic JSON shapes.            Shared by the API, export and publish.
repositories/   DB access.                      Only place that imports ORM models.
adapters/   External I/O.                       Market data, FX, broker files; return dataclasses.
domain/     Pure math.                          XIRR, TWR, CAGR, allocation, risk.
models/     SQLAlchemy ORM.                     Schema definition only.
storage/    Paths, cloud detection, encryption, sidecar guard, locks, backups.
```

Notes beyond the rules in `AGENTS.md`:

- `domain/` is checked with `mypy --strict`, which is what keeps it pure.
- Services own transactions: a use-case is one logical commit.
- Page queries live in `readmodels/queries/*_query.py` (the old
  `ui/pages/_*_query.py` names are re-export shims for v5); they read through
  repositories, never ORM selects of their own.
- Cashflow and currency legs come from one module, `services/cashflows.py`;
  positions and per-instrument metrics from one pass, `services/ledger_walk.py`.

## Storage tiers (split-DB layout)

The schema is partitioned across **three storage tiers**, each owning its own
SQLAlchemy `DeclarativeBase` / `MetaData` (`models/base.py`):

```
LedgerBase  Facts that happened.   accounts, instruments, transactions.   Encrypted + cloud-synced.
ConfigBase  User choices.          settings, target allocations, overrides, write-queue.   Encrypted + cloud-synced.
CacheBase   Derived, regenerable.  price_history, fx_history, snapshots, refresh metadata.   Device-local, never synced.
```

Two physical layouts exist behind the same ORM:

- **Single-file (default).** All three tiers share one SQLite file. The
  caller's session sees every table, so tier routing is a transparent no-op.
- **Split-DB (cloud installs).** Each tier is a separate SQLite file — typically
  ledger + config on cloud storage (OneDrive) and the cache on a local disk.
  A session bound to one tier **cannot see another tier's tables.**

### Hard rules for tiers

- **No cross-tier `ForeignKey` or `relationship`.** SQLAlchemy can't bridge
  separate `MetaData` instances, and in split-DB mode the tables live in
  different files where DB-level FKs aren't enforceable anyway. Cross-tier
  references are plain integer columns; integrity is kept at the application
  level (writers validate; a boot-time cache-orphan janitor sweeps dangling
  cache rows).
- **Route every cache-tier read/write through `db.cache_read_session` /
  `db.cache_write_session`** (the `*_service` wrappers already do this). In
  single-file mode they reuse the caller's session; in split-DB mode they open
  a short-lived cache-tier session against the cache engine. Querying cache
  tables through a ledger session hits the ledger DB's (empty) copies and
  returns `None`/`[]` for every lookup — zeroing historical valuations,
  inflating YTD, and dropping MTD.
- **Boot creates every tier's schema.** Alembic migrates the *ledger* tier
  only, so `boot._ensure_secondary_tier_schema` runs `create_all` on the config
  and cache engines after an upgrade; otherwise a split-DB cache database stays
  schemaless and the background refresh writes silently fail.
- **Use `ALL_METADATAS`** for `create_all`/`drop_all` in tests and boot so
  adding a tier later stays a one-line change.

## Data model essentials

- **`transactions`** is the unified ledger. Every position change, dividend,
  fee, deposit, and interest credit is one row, with a `kind` enum and a
  sign convention (see spec §4.1).
- **All money is `Numeric(18, 6)`**; shares are `Numeric(18, 8)`; FX rates
  are `Numeric(12, 8)`. SQLAlchemy hands back `decimal.Decimal`; no float
  drift downstream.
- **FX:** each transaction's EUR/USD amount is derived from `net_native` and that
  date's rate (FX conversion batches override the EUR side via the FIFO pool). The
  frozen `fx_rate_to_eur` / `net_eur` / `net_usd` legs are still written on import
  for the v5 rollback and are only a cross-check (Diagnostics flags > 0.5 %
  differences). Snapshots and intraday samples store native USD plus the
  per-instant rate; EUR is `usd / fx` at that instant.
- **`UNIQUE(account_id, external_id)`** on transactions is the dedup guard.
  CSV importers compute a SHA-256 over the raw row fields as `external_id`. On top,
  the importer skips rows whose content (date, kind, symbol, quantity, amount)
  matches a transaction already booked, so the same trades exported in another
  format are not imported twice.
- **Importers:** Fidelity and Vanguard files go through their exact parsers
  (`adapters/fidelity`, `adapters/vanguard`). Anything else, and any broker file
  those parsers can't read, goes through the flexible reader (`adapters/tabular` +
  `adapters/generic`): any CSV/TSV/XLSX, header found anywhere (or none), columns
  matched by name in several languages or by content, number format and date order
  inferred. What it can't settle (a missing price, an ambiguous date order) becomes
  a question on the Import page: pick a column, work it out, or cancel. Layouts the
  user fixes can be remembered (`import.column_profiles`).

## External data flow

```
yfinance ───► price_history (raw closes, auto_adjust=False)
Frankfurter ─► fx_history   (EUR base, USD quote, ECB rates)
Broker files ─► transactions (exact or flexible parser; external_id + content dedup)
Manual entry ──► transactions (source='manual')
```

Refresh runs on app start; a "Refresh" button in `/settings` triggers it
on demand. Failures are non-fatal — stale prices/FX still render, with a
"last refreshed" indicator in the footer.

## Why these choices

- **NiceGUI**: event-driven (no full-rerun model), binds to `0.0.0.0` trivially.
- **SQLite + WAL**: single user, one file to back up, real transactions.
- **Alembic with `render_as_batch=True`**: SQLite can't `ALTER COLUMN`; batch ops
  rebuild the table transparently.
- **`auto_adjust=False` in yfinance**: dividends are tracked in the ledger;
  auto-adjusted closes would double-count them.
- **mypy strict on `domain/` only**: the financial maths is where bugs matter most.

## Accessibility

The owner is **protan** (red-green) colour-blind. The UI never uses red/green for
gain/loss: gains are blue (`--color-pos`), losses orange (`--color-neg`), with
signs and arrows as well. Every colour pair that is on screen together with
different meanings (chart series, the 1D trend-coloured primary line vs the
second-currency line, status dots, warn vs neg) is checked in a Machado 2009 protan
simulation with CIEDE2000 (≥ 20; ≥ 15 for deutan and normal vision), in light and
dark themes, plus text and line contrast as a protan sees it. Secondary chart series
are dashed, so they never depend on colour alone. The check is the frontend test
`frontend/src/styles/tokens.cvd.test.ts` (helpers in `frontend/src/lib/cvd.ts`);
the rule lives in `AGENTS.md` › "Colour accessibility".
