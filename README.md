# Investment Dashboard

A single-user, locally-hosted Python investment-tracking dashboard that unifies
brokerage positions at **Vanguard** and **Fidelity** with a German savings
account (**Direct Savings (Tagesgeld)**). It computes a rich set of
return metrics — XIRR, TWR, CAGR, YTD variants, drawdown, Sharpe, Sortino —
in both **USD** and **EUR**, and serves them over a NiceGUI web UI accessible
from the host laptop and any device on the same Wi-Fi network.

> **Status: v1.2.0 — snapshots cache, near-live ETF prices, monthly
> projection, one-click launcher.** All seven pages registered
> (`/overview`, `/deposits`, `/transactions`, `/monthly`, `/yearly`,
> `/calculator`, `/settings`), CSV import for Fidelity and Vanguard,
> XIRR/TWR/CAGR computed from the live ledger, allocation treemap,
> colorblind-safe theme, idempotent boot sequence. v1.2 adds a daily
> `position_snapshots` cache (constant-time period close-outs), a
> per-instrument TTL refresh that keeps ETFs/stocks updated every
> ~2 minutes during market hours, a 36-month projection on
> `/monthly`, a Modified-Dietz growth-% column on both period pages,
> editable `expense_ratio` / `active` fields in `/settings`, and a
> double-clickable launcher (`run_dashboard.bat` / `.sh` / `.py`)
> that needs no command line. 188 tests pass; lint/format/mypy clean.

## Highlights

- **Layered architecture** — `domain/` (pure math), `adapters/` (external
  I/O), `repositories/` (DB), `services/` (orchestration), `ui/` (NiceGUI).
- **SQLAlchemy 2.x + Alembic** on a single SQLite file (WAL mode).
- **FX-aware** — every USD cashflow stored with the EUR rate of its trade
  date, so EUR returns reflect when the money actually moved.
- **Colorblind-safe** UI (Wong palette) — never relies on red/green alone.
- **Private**, single-user, $0 hosting. Runs on `0.0.0.0:8080`.

## Tech stack

| Layer | Choice |
|---|---|
| Language | Python ≥ 3.12 |
| Web UI | NiceGUI (FastAPI + Quasar) |
| Charts | Plotly |
| ORM / DB | SQLAlchemy 2.x + SQLite (WAL) |
| Migrations | Alembic |
| FX rates | [Frankfurter](https://frankfurter.dev) (ECB-sourced) |
| Market data | yfinance (`auto_adjust=False`) |
| Tests | pytest + hypothesis + respx |
| Lint / format | ruff |
| Type-check | mypy (strict on `domain/`) |
| Package manager | uv |
| CI | GitHub Actions |

Full rationale in [`docs/architecture.md`](docs/architecture.md) and the
`requirements_and_project_overview.md` spec.

## Quickstart

### One-click launcher (no command line)

The fastest path — works on a fresh clone without any prior Python
setup beyond having Python 3.12+ on `PATH`.

- **Windows:** double-click `run_dashboard.bat`. First run bootstraps
  a local `.venv` and installs dependencies (≈1 minute); subsequent
  runs are instant.
- **macOS / Linux:** `./run_dashboard.sh` (already executable).
- **From any IDE / shell:** `python run_dashboard.py`.

The launcher opens the dashboard in your default browser
automatically; close the terminal window (or press Ctrl+C in it) to
stop the server.

### Manual / development install

```powershell
# Install uv if you don't have it (Windows):
pip install --user uv

# From the repo root:
uv sync                          # install all deps + dev extras
uv run alembic upgrade head      # create the SQLite schema
uv run investment-dashboard      # launches NiceGUI on http://0.0.0.0:8080
```

Open `http://localhost:8080` on the laptop, or `http://<laptop-LAN-IP>:8080`
from a phone on the same Wi-Fi.

## Configuration

All settings are env-vars prefixed `INV_DASHBOARD_` and can be set in a `.env`
file at the repo root. See [`.env.example`](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `INV_DASHBOARD_DB_PATH` | `%LOCALAPPDATA%/inv-dashboard/db.sqlite` on Windows | SQLite file path |
| `INV_DASHBOARD_HOST` | `0.0.0.0` | Bind address |
| `INV_DASHBOARD_PORT` | `8080` | Bind port |
| `INV_DASHBOARD_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

## Development

```powershell
uv sync --extra dev

uv run ruff check .
uv run ruff format --check .
uv run mypy src/investment_dashboard/domain
uv run pytest                      # excludes network smoke tests
uv run pytest --run-network        # include them
```

Pre-commit hooks: `uv run pre-commit install` once, then they run on every
commit.

## Project layout

```
src/investment_dashboard/
├── adapters/          # frankfurter_client, yfinance_client, broker CSVs (Phase 1+)
├── domain/            # pure math: XIRR, TWR, CAGR, allocation, risk (Phase 2)
├── models/            # SQLAlchemy ORM
├── repositories/      # DB access (Phase 2)
├── services/          # use-case orchestration
└── ui/                # NiceGUI pages + components
migrations/            # Alembic
tests/                 # mirrors src layout
docs/                  # architecture notes
```

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  NiceGUI app (FastAPI + Quasar)  — bind 0.0.0.0:8080        │
│  Pages: /overview /deposits /transactions /monthly /yearly  │
│         /calculator /settings                               │
└──────────────────────┬──────────────────────────────────────┘
   ┌───────────────────┼───────────────────────────────┐
   ▼                   ▼                               ▼
┌────────────┐  ┌──────────────────┐         ┌──────────────────┐
│ services/  │  │ domain/          │         │ adapters/        │
│ orchestrate│  │ pure math:       │         │ external IO:     │
│ use-cases  │  │ XIRR, TWR, CAGR  │         │ yfinance,        │
│            │  │ allocation       │         │ frankfurter,     │
│            │  │ risk             │         │ broker CSVs      │
└─────┬──────┘  └──────────────────┘         └────────┬─────────┘
      │                                                │
      ▼                                                │
┌────────────────────┐                                 │
│ repositories/      │◄────────────────────────────────┘
│ SQLAlchemy session │
└─────────┬──────────┘
          ▼
   ┌────────────┐
   │ SQLite DB  │
   └────────────┘
```

## Roadmap

See [`requirements_and_project_overview.md`](requirements_and_project_overview.md)
§14 for the full phased roadmap. Current status:

- ✅ Phase 0 — scaffolding, CI.
- ✅ Phase 1 — schema, migrations, FX + market-data adapters, CSV
  importers (Fidelity + Vanguard).
- ✅ Phase 2 — `domain/` pure math: XIRR, TWR, CAGR, returns, risk,
  rebalance allocation.
- ✅ Phase 3 — Repositories, services, importer service, UI shell.
- ✅ Phase 4 — All seven pages wired with live data: `/overview`,
  `/deposits`, `/transactions`, `/monthly`, `/yearly`, `/calculator`,
  `/settings`.
- ✅ Phase 5 (v1.1) — End-of-period mark-to-market closing balances,
  inline editing for accounts/instruments/allocations, yearly
  hypothetical projection block.
- ⏳ Phase 6 (v1.2+) — Snapshots cache (spec §4.1) to avoid recomputing
  positions on every page render, JAN-1 backfill for `ytd_start_value`,
  monthly projection rows.

## License

Proprietary, private repository. No public license granted.
