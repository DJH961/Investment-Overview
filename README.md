# Investment Dashboard

A single-user, locally-hosted Python investment-tracking dashboard that unifies
brokerage positions at **Vanguard** and **Fidelity** with a German savings
account (**Direct Savings (Tagesgeld)**). It computes a rich set of
return metrics — XIRR, TWR, CAGR, YTD variants, drawdown, Sharpe, Sortino —
in both **USD** and **EUR**, and serves them over a NiceGUI web UI accessible
from the host laptop and any device on the same Wi-Fi network.

> **Status: v0.1.0 — scaffolding (Phase 0 + 1).** Data model, FX/market-data
> adapters, Alembic migrations, tests, lint, type-check, and CI are in place.
> No runnable UI yet — the placeholder NiceGUI page just confirms binding works.
> **v1.0.0 will be the first release with a usable UI** (CSV/manual ingestion
> through to `/overview` showing real XIRR/TWR numbers).

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

- ✅ Phase 0 — scaffolding, CI, hello-world UI.
- ✅ Phase 1 (partial) — schema, migrations, FX + market-data adapters. CSV
  importers and `/transactions` CRUD UI are next.
- ⏳ Phase 2 — `domain/returns.py` (XIRR/TWR/CAGR), `/overview` page.
- ⏳ Phase 3+ — Vanguard + Savings flows, monthly/yearly/calculator pages,
  risk metrics, mobile-responsive polish.

## License

Proprietary, private repository. No public license granted.
