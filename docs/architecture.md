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
- **UI never reaches past services.** No `from investment_dashboard.repositories
  import …` in any `ui/` module.

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
