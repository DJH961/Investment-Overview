# Investment Dashboard

A personal, single-user investment dashboard. It imports broker exports into a
transaction **ledger** and computes portfolio returns from it: XIRR, TWR, CAGR,
YTD/MTD variants, drawdown, Sharpe/Sortino and other risk metrics. Everything is
reported in **EUR or USD** with a currency-aware model: amounts are stored in their
native currency, cashflows convert at their own date's rate and valuations at the
valuation moment's rate, so EUR returns are FX-aware (rule in
[`AGENTS.md`](AGENTS.md)).

## Status

| Track | State |
| --- | --- |
| **v6 "One App"** (6.0.0) | **Live.** One hosted FastAPI backend ([`backend/`](backend/)) plus a React frontend ([`frontend/`](frontend/)) on the owner's server, replacing both v5 apps. Plan: [`docs/v6_one_app_plan.md`](docs/v6_one_app_plan.md). |
| **v5.3.1** | Final v5 release, **frozen, no support**: preserved on branch `legacy/v5` / tag `v5.3.1`. The v5 code was removed from `main` in 7.0 and is archived under the tag `v5-archive` ([how to read it](docs/legacy_v5.md)). The GitHub Pages site ([`web/`](web/)) serves only an offline demo. |

## Quick start (development)

Requires Python 3.12+, [`uv`](https://docs.astral.sh/uv/) and Node 20+. The app is a
FastAPI server ([`backend/`](backend/)) serving the React frontend
([`frontend/`](frontend/)); production runs on the owner's server
([`deploy/RUNBOOK.md`](deploy/RUNBOOK.md)).

```powershell
cd backend
uv sync                          # add --extra dev for lint/test tooling
uv run inv-dashboard-server      # API on http://127.0.0.1:8080 (see backend/.env.example)
cd ..\frontend; npm install; npm run dev
```

Settings are `INV_DASHBOARD_*` environment variables (or a git-ignored `.env`);
every variable is documented in [`backend/.env.example`](backend/.env.example). Useful CLIs:
`inv-dashboard-backup`, `inv-dashboard-restore`, `inv-dashboard-split-db`,
`inv-dashboard-repair-sidecar`, `inv-dashboard-export-snapshot`,
`inv-dashboard-upload-db`, `inv-dashboard-set-password`.
Not sure what a screen does? Use the in-app Help page or the
[user guide](docs/user_guide.md).

## Features

- **Ledger first:** every position change, dividend, fee and deposit is one
  transaction row; broker-agnostic importers (CSV/XLSX) emit a common row format and
  de-duplicate on re-import.
- **Returns and risk:** XIRR, TWR, CAGR, drawdown, volatility, Sharpe/Sortino and
  more, per holding and for the portfolio, in EUR and USD.
- **Pages:** overview, deposits, transactions, monthly, yearly, rebalancing
  calculator, projection, analytics, settings and data health.
- **Hosted storage:** one SQLCipher-encrypted database on the server, sealed
  off-site backups.
- **Offline demo:** `web/` builds a no-data demo for GitHub Pages.

## Repository layout

```
backend/src/investment_dashboard/   Python package (layers: api -> services/readmodels
                            -> repositories/adapters -> domain; see docs/architecture.md)
backend/migrations/         Alembic migrations
backend/tests/              pytest suite, mirrors src/
frontend/                   React frontend (the real app)
web/                        offline demo for GitHub Pages (VITE_DEMO_ONLY=1)
deploy/                     server stack, runbook, bootstrap
backend/tools/              helper scripts
docs/                       architecture, user guide, legacy guide, v6 plan (see docs/README.md)
```

The Python project lives in `backend/` (run all `uv` commands from there).

## Development

```powershell
cd backend
uv sync --extra dev
uv run ruff format . ; uv run ruff check . --fix
uv run mypy src/investment_dashboard/domain
uv run pytest                      # add --run-network for live-API tests
cd ..\frontend; npm run typecheck; npm run test
cd ..\web; npm run typecheck; npm run test
```

## Documentation and project files

- [`docs/README.md`](docs/README.md): documentation index
- [`AGENTS.md`](AGENTS.md): project rules (single source of truth)
- [`CONTRIBUTING.md`](CONTRIBUTING.md): dev setup and workflow
- [`SECURITY.md`](SECURITY.md): security model and vulnerability reporting
- [`CHANGELOG.md`](CHANGELOG.md): what shipped when
- [`LICENSE.md`](LICENSE.md): PolyForm Noncommercial 1.0.0. Free for any
  noncommercial use, commercial use not permitted (source-available, not OSI
  open source).
