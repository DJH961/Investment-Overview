# Investment Dashboard

A single-user, locally-hosted Python investment-tracking dashboard that unifies
brokerage positions at **Vanguard** and **Fidelity** with a German savings
account (**Direct Savings (Tagesgeld)**). It computes a rich set of
return metrics — XIRR, TWR, CAGR, YTD variants, drawdown, Sharpe, Sortino —
in both **USD** and **EUR**, and serves them over a NiceGUI web UI accessible
from the host laptop and any device on the same Wi-Fi network.

> **Status: v2.0.0 — split storage, cloud-aware paths, optional SQLCipher,
> and SQLite file-safety tooling.** The app remains a local-first,
> single-user dashboard with onboarding, EUR/USD display switching, CSV/XLSX
> imports, live overview/deposits/transactions/monthly/yearly/calculator pages,
> and editable settings. v2.0 adds separate ledger/config/cache tiers, keeps
> cache data local by default, detects common cloud-sync folders, optionally
> encrypts synced tiers with SQLCipher, blocks unsafe WAL sidecars in cloud
> folders, takes rolling backups, and exposes repair/backup/split CLIs.

## Highlights

- **Layered architecture** — `domain/` (pure math), `adapters/` (external
  I/O), `repositories/` (DB), `services/` (orchestration), `ui/` (NiceGUI).
- **SQLAlchemy 2.x + Alembic** on SQLite, with ledger/config/cache storage
  tiers. Existing single-file installs still work unchanged.
- **Cloud-aware local-first storage** — ledger/config can live in OneDrive,
  iCloud, Dropbox, or Google Drive; cache stays device-local by default.
- **Optional encryption at rest** for synced tiers via the `[encrypted]` extra
  (`pysqlcipher3`/`sqlcipher3` + keyring).
- **SQLite file safety** — cloud-located DBs use TRUNCATE journaling; boot
  guards against stray `-wal`/`-shm` sidecars and takes rolling backups.
- **FX-aware** — every USD cashflow stored with the EUR rate of its trade
  date, so EUR returns reflect when the money actually moved.
- **Modern colorblind-safe UI** with light/dark chrome and a Settings →
  Storage panel showing each tier path/source.
- **Private**, single-user, $0 hosting. Runs on `0.0.0.0:8080`.

## Tech stack

| Layer | Choice |
|---|---|
| Language | Python ≥ 3.12 |
| Web UI | NiceGUI (FastAPI + Quasar) |
| Charts | Plotly |
| ORM / DB | SQLAlchemy 2.x + SQLite tiers (WAL local, TRUNCATE in cloud) |
| Migrations | Alembic |
| Optional encryption | SQLCipher via `investment-dashboard[encrypted]` |
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

### Install on another Windows PC (single file, no clone)

Download **`InvestmentDashboard-Setup.exe`** from the
[latest release](https://github.com/DJH961/Investment-Overview/releases/latest)
and double-click it. The installer

1. drops a per-user copy of CPython 3.12 and the dashboard into
   `%LOCALAPPDATA%\InvestmentDashboard` (no admin rights needed),
2. creates Start-menu + Desktop shortcuts, and
3. launches the dashboard immediately.

Every later launch (via the shortcut) checks the GitHub Releases API and
self-updates to the newest `v*` tag before starting. See
[`installer/README.md`](installer/README.md) for the design and the
release pipeline that produces the `.exe`.

### Portable bundle for locked-down work laptops (no admin, no SmartScreen)

If the `.exe` installer is blocked by Windows SmartScreen ("Unknown
publisher"), or if your corporate proxy blocks `api.github.com` and
makes the network-driven installer fail with `HTTP Error 404`,
download **`InvestmentDashboard-Portable.zip`** from the same
[Releases page](https://github.com/DJH961/Investment-Overview/releases/latest)
instead.

1. Right-click the ZIP → *Extract All…* into any folder you can write to
   (e.g. `%USERPROFILE%\InvestmentDashboard`).
2. Double-click **`Run Investment Dashboard.cmd`** inside the extracted
   folder. The dashboard opens in your default browser.

The portable bundle contains an embeddable CPython 3.12 runtime and a
pre-installed copy of the dashboard, so it runs **completely offline**,
requires **no admin rights**, and `.cmd` scripts are **not** subject to
the SmartScreen unsigned-`.exe` block.

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
| `INV_DASHBOARD_DB_PATH` | platform local data dir | Legacy single-file SQLite path; if set, all tiers share this file |
| `INV_DASHBOARD_LEDGER_PATH` | cloud root if detected, else local data dir | Ledger/source-of-truth SQLite file |
| `INV_DASHBOARD_CONFIG_PATH` | cloud root if detected, else local data dir | User preferences/overrides SQLite file |
| `INV_DASHBOARD_CACHE_PATH` | platform local data dir | Derived cache SQLite file; intentionally local by default |
| `INV_DASHBOARD_ENCRYPT_SYNCED_TIERS` | `false` | Enable SQLCipher for ledger/config tiers |
| `INV_DASHBOARD_DB_PASSPHRASE` | unset | SQLCipher passphrase override; normally use OS keyring |
| `INV_DASHBOARD_HOST` | `0.0.0.0` | Bind address |
| `INV_DASHBOARD_PORT` | `8080` | Bind port |
| `INV_DASHBOARD_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

### Storage, cloud sync, and safety tools

By default v2.0 resolves storage in this order:

1. explicit env vars (`INV_DASHBOARD_LEDGER_PATH`, `...CONFIG_PATH`,
   `...CACHE_PATH`);
2. persisted config overrides for ledger/config;
3. detected cloud-sync root for ledger/config only;
4. platform local data dir fallback. Cache never uses the persisted/cloud step.

The Settings → Storage panel shows the active path and resolver source for each
tier. If ledger/config are inside a detected cloud folder, SQLite opens them
with `journal_mode=TRUNCATE` and boot refuses to proceed if stale
`*.sqlite-wal` or `*.sqlite-shm` sidecars are present.

Useful CLIs:

```powershell
uv run inv-dashboard-split-db --from old.sqlite --ledger ledger.sqlite --config config.sqlite --cache cache.sqlite
uv run inv-dashboard-repair-sidecar path/to/ledger.sqlite
uv run inv-dashboard-backup --verify path/to/ledger.sqlite
```

For encrypted synced tiers:

```powershell
uv sync --extra encrypted
set INV_DASHBOARD_ENCRYPT_SYNCED_TIERS=true
set INV_DASHBOARD_DB_PASSPHRASE=your-local-passphrase   # or store it in keyring
```

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
├── storage/           # cloud paths, encryption, sidecars, locks, backups
├── tools/             # split-db, repair-sidecar, backup CLIs
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
   ┌──────────────────────────────────────────────┐
   │ SQLite tiers                                 │
   │ ledger.sqlite · config.sqlite · cache.sqlite │
   └──────────────────────────────────────────────┘
```

## Roadmap

See [`requirements_and_project_overview.md`](requirements_and_project_overview.md)
and [`docs/v2.0_split_cloud_security_plan.md`](docs/v2.0_split_cloud_security_plan.md)
for the full roadmap. Current status:

- ✅ v1.x — schema, adapters/importers, domain math, repositories/services,
  onboarding, all UI pages, snapshots/cache refresh, Vanguard XLSX import, and
  the v1.5 UI facelift.
- ✅ v2.0 Phase 1–2 — ORM metadata split and tier-specific engines/sessions.
- ✅ v2.0 Phase 3 — cloud-sync-aware path resolution.
- ✅ v2.0 Phase 4 — optional SQLCipher encryption for synced tiers.
- ✅ v2.0 Phase 5 — sidecar guard, single-writer lock, integrity checks, and
  rolling backups.
- ⏳ Follow-ups — onboarding passphrase prompt, Settings “Move ledger…” picker,
  and per-tier Alembic version tables.

## License

Proprietary, private repository. No public license granted.
