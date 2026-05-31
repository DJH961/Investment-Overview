# Architecture

A one-page distillation of the full spec
(`requirements_and_project_overview.md`). When the two disagree, the spec
wins; PRs welcome to keep this doc honest.

## Goal

A local-first, single-user investment dashboard whose ground truth is a
**transaction ledger**, with rich return metrics in **USD and EUR**,
accessible from any device on the user's Wi-Fi.

## Layered structure

```
ui/         NiceGUI pages, components, copy.    Thin: input → service → render.
services/   Use-case orchestration.             Composes domain + adapters + repos.
repositories/   DB access.                      Only place that imports ORM models.
adapters/   External I/O.                       yfinance, Frankfurter, broker CSVs.
domain/     Pure math.                          XIRR, TWR, CAGR, allocation, risk.
models/     SQLAlchemy ORM.                     Schema definition only.
```

### Hard rules

- **`domain/` is pure.** No `Session`, no `httpx`, no `yfinance`, no
  filesystem. Mypy runs in `--strict` mode here precisely to enforce this.
- **Adapters return dataclasses**, never ORM rows. This keeps DB concerns
  out of network code.
- **Repositories return ORM rows or domain dataclasses**, never raw dicts.
  Callers should be able to rename a column without grepping the codebase.
- **Services own transactions.** A use-case is one logical commit. UI never
  starts a transaction directly.
- **UI prefers services, but may read repositories directly.** Read-heavy
  pages (`ui/pages/_overview_query.py`, `transactions.py`, `settings.py`,
  `calculator.py`, …) import ledger-tier repositories such as
  `transactions_repo` / `instruments_repo` for straightforward queries.
  Mutations and any multi-step use-case still go through a service so the
  commit boundary stays in one place.
- **Cache-tier reads/writes go through their service, never a raw repo on the
  caller's session.** Prices, FX history, and snapshots live in the *cache*
  tier (see "Storage tiers" below). Call `prices_service`, `fx_service`, or
  `snapshots_service` — they route to the cache engine. Calling
  `prices_repo` / `fx_repo` / `snapshots_repo` directly with a ledger/config
  session silently returns empty results under a split-DB layout. This is the
  exact bug class that zeroed closing values in v2.9.4.

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
- **FX rate is stamped at transaction time** (`fx_rate_to_eur` + cached
  `net_eur`) so historical EUR returns reflect the rate that actually
  applied — not today's rate.
- **`UNIQUE(account_id, external_id)`** on transactions is the dedup guard.
  CSV importers compute a SHA-256 over the raw row fields as `external_id`.

## External data flow

```
yfinance ───► price_history (raw closes, auto_adjust=False)
Frankfurter ─► fx_history   (EUR base, USD quote, ECB rates)
CSV importers ─► transactions (with computed external_id for dedup)
Manual entry ──► transactions (source='manual')
```

Refresh runs on app start; a "Refresh" button in `/settings` triggers it
on demand. Failures are non-fatal — stale prices/FX still render, with a
"last refreshed" indicator in the footer.

## Why these choices

- **NiceGUI** over Streamlit: event-driven; no full-rerun model; binds
  to `0.0.0.0` trivially; built-in Quasar/Tailwind components.
- **SQLite + WAL**: single user, one file to back up, real transactions.
- **Alembic with `render_as_batch=True`**: SQLite can't `ALTER COLUMN`,
  but Alembic's batch ops rebuild the table transparently.
- **`auto_adjust=False` in yfinance**: dividends are tracked in our ledger;
  auto-adjusted closes would double-count them.
- **mypy strict on `domain/` only**: the financial math is where bugs
  matter most. Adapters and UI move fast; domain code should not.

## Accessibility note

The user is red-green colorblind (deuteranopia/protanopia category). The UI
**never uses red/green as the only signal** for gain/loss. We use the
Wong (2011) palette: blue `#0072B2` for gain, orange `#E69F00` for loss,
plus directional arrows.
