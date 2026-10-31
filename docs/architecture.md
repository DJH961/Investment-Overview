# Architecture

How the current (v5.3.1) system is put together. The rules that govern the code
(layering, cache-tier access, currency) live in [`../AGENTS.md`](../AGENTS.md); the
original requirements are in [`original_spec.md`](original_spec.md); the hosted v6
rewrite is in [`v6_one_app_plan.md`](v6_one_app_plan.md).

## Goal

A local-first, single-user investment dashboard whose ground truth is a
**transaction ledger**, with rich return metrics in **USD and EUR**, reachable from
any device on the user's LAN. A read-only, encrypted web companion (`web/`) gives a
phone view from a published snapshot.

## Layered structure

```
ui/         NiceGUI pages, components, copy.    Thin: input -> service -> render.
api/        Read-only FastAPI JSON API.         Opt-in; serves readmodels.
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
- Read-heavy UI pages (`ui/pages/_overview_query.py`, `transactions.py`,
  `settings.py`, `calculator.py`, ...) may query ledger-tier repositories directly;
  mutations and multi-step use-cases go through a service.

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
- **v5 FX storage:** transactions still carry frozen `fx_rate_to_eur` / `net_eur`
  / `net_usd` legs so EUR returns use each cashflow's own date rate. This is the
  v5 transition state; see the currency rule in `AGENTS.md` and plan section 2 for
  the v6 migration.
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

- **NiceGUI**: event-driven (no full-rerun model), binds to `0.0.0.0` trivially.
- **SQLite + WAL**: single user, one file to back up, real transactions.
- **Alembic with `render_as_batch=True`**: SQLite can't `ALTER COLUMN`; batch ops
  rebuild the table transparently.
- **`auto_adjust=False` in yfinance**: dividends are tracked in the ledger;
  auto-adjusted closes would double-count them.
- **mypy strict on `domain/` only**: the financial maths is where bugs matter most.

## Accessibility

The owner is red-green colorblind. The UI never uses red/green as the only gain/loss
signal: it uses the Wong (2011) palette (blue `#0072B2` gain, orange `#E69F00` loss)
plus directional arrows.
