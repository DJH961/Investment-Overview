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
| **v5.3.1** (this code) | Final v5 release: local NiceGUI desktop app plus a read-only, end-to-end-encrypted web companion ([`web/`](web/)). **Frozen, no support.** Kept running until the v6 cutover; also preserved on branch `legacy/v5` / tag `v5.3.1` ([rollback guide](docs/legacy_v5.md)). |
| **v6 "One App"** | In progress: one hosted FastAPI backend plus a React frontend replacing both v5 apps. Plan: [`docs/v6_one_app_plan.md`](docs/v6_one_app_plan.md). |

## Quick start (current v5 code)

Requires Python 3.12+ and [`uv`](https://docs.astral.sh/uv/).

```powershell
cd backend
uv sync                          # add --extra dev for lint/test tooling
uv run alembic upgrade head      # create the SQLite schema
uv run investment-dashboard      # NiceGUI on http://localhost:8080
```

No command line needed: double-click `run_dashboard.vbs` (Windows, no console) or
`run_dashboard.bat` (Windows, visible console), run `./run_dashboard.sh`
(macOS/Linux), or `python run_dashboard.py`. The first run bootstraps a local
`.venv`. On Windows there is also a one-file installer and a portable bundle, see
[`installer/README.md`](installer/README.md). Startup failures are written to
`launcher.log` next to the launcher.

The server is **LAN-only by design** (binds `0.0.0.0:8080`); do not expose it to
the internet ([`SECURITY.md`](SECURITY.md)).

Settings are `INV_DASHBOARD_*` environment variables (or a git-ignored `.env`);
every variable is documented in [`.env.example`](.env.example). Useful CLIs:
`inv-dashboard-backup`, `inv-dashboard-split-db`, `inv-dashboard-repair-sidecar`,
`inv-dashboard-export-snapshot`, `inv-dashboard-publish-web`, `inv-dashboard-api`.
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
- **Local-first storage:** separate ledger / config / cache SQLite tiers; ledger and
  config may live in a cloud-synced folder (optionally SQLCipher-encrypted), the
  cache stays on the device.
- **Web companion:** an encrypted snapshot published to a GitHub release and
  decrypted in the browser, for a read-only phone view.

## Repository layout

```
backend/src/investment_dashboard/   Python package (layers: ui/api -> services/readmodels
                            -> repositories/adapters -> domain; see docs/architecture.md)
backend/migrations/         Alembic migrations
backend/tests/              pytest suite, mirrors src/
web/                        v5 read-only web companion (TypeScript) + web/proxy Cloudflare Worker
installer/                  Windows installer and portable-bundle build
backend/tools/              helper scripts
docs/                       architecture, user guide, legacy guide, v6 plan (see docs/README.md)
run_dashboard.*             one-click launchers
```

The Python project lives in `backend/` (run all `uv` commands from there); `web/`
moves to `frontend/` at the start of v6 Phase 1
([plan §4a](docs/v6_one_app_plan.md)).

## Development

```powershell
cd backend
uv sync --extra dev
uv run ruff format . ; uv run ruff check . --fix
uv run mypy src/investment_dashboard/domain
uv run pytest                      # add --run-network for live-API tests
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
