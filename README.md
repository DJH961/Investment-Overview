# Investment Dashboard

A single-user, locally-hosted Python investment-tracking dashboard that unifies
brokerage positions at **Vanguard** and **Fidelity** with a German savings
account (**Direct Savings (Tagesgeld)**). It computes a rich set of
return metrics — XIRR, TWR, CAGR, YTD variants, drawdown, Sharpe, Sortino —
in both **USD** and **EUR**, and serves them over a NiceGUI web UI accessible
from the host laptop and any device on the same Wi-Fi network.

> **Status: v2.11.1 — split storage, cloud-aware paths, optional SQLCipher,
> intraday price refresh, SQLite file-safety tooling, an equity-curve
> performance pass, and the v3.0 live-web companion (encrypted publish + an
> in-browser dashboard, see [`web/`](web/)).** The app remains a
> local-first, single-user dashboard with onboarding, EUR/USD display switching,
> CSV/XLSX imports, live overview/deposits/transactions/monthly/yearly/calculator
> pages, a standalone projection page, and editable settings. It runs separate
> ledger/config/cache tiers, keeps cache data local by default, detects common
> cloud-sync folders, optionally encrypts synced tiers with SQLCipher, blocks
> unsafe WAL sidecars in cloud folders, takes rolling backups, and exposes
> repair/backup/split CLIs.

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
- **Private deployment**, single-user, $0 hosting. Runs on `0.0.0.0:8080` and is
  LAN-only by design (the *deployment* is private even though this source
  repository is public — see [`SECURITY.md`](SECURITY.md)).

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
2. Double-click **`Run-InvestmentDashboard.cmd`** inside the extracted
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

### Using the app (help & user guide)

Not sure what a screen or a setting does? The app ships with built-in help:

- Click the **`?` icon** in the top-right header, or open **Settings → Help &
  documentation**, to reach the in-app **Help & user guide** page. It explains
  every page and walks through each Settings control in plain English.
- Hover the small **ⓘ icon** next to any metric for a one-line explanation in
  context.
- The same walkthrough is available as a portable markdown file:
  [`docs/user_guide.md`](docs/user_guide.md).

You do not need to understand the maths to use the dashboard.

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
| `INV_DASHBOARD_API_ENABLED` | `false` | Mount the read-only JSON API at `/api` on the server |
| `INV_DASHBOARD_API_TOKEN` | unset | Optional bearer token guarding `/api` (set when exposed beyond LAN) |
| `INV_DASHBOARD_SNAPSHOT_PATH` | beside config tier | Output path for `inv-dashboard-export-snapshot` |
| `INV_DASHBOARD_PUBLISH_ENABLED` | `false` | Enable the v3.0 live-web encrypted publish pipeline |
| `INV_DASHBOARD_PUBLISH_REPO` | unset | Target `owner/name` repo for the published `portfolio.enc` |
| `INV_DASHBOARD_PUBLISH_RELEASE_TAG` | `live-data` | Release tag whose single asset is overwritten each publish |
| `INV_DASHBOARD_PUBLISH_INCLUDE_TRANSACTIONS` | `false` | Include the transaction list in the published export |
| `INV_DASHBOARD_PUBLISH_TOKEN` | unset | GitHub PAT for publishing; normally use OS keyring |
| `INV_DASHBOARD_MOBILE_PASSPHRASE` | unset | Live-web blob passphrase; normally use OS keyring |
| `INV_DASHBOARD_DEV_PASSWORD` | unset | Optional password gating Settings → Developer tools (the full audit export) |

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

### Mobile companion: read-only JSON API + snapshot export

A UI-agnostic JSON read-model layer (`readmodels/`) exposes the same
numbers the web UI shows, for a future Android app. It is delivered two
ways, both built from the same `readmodels.build_snapshot()`:

```powershell
# Live API on the existing server (opt-in), guarded by an optional token:
set INV_DASHBOARD_API_ENABLED=true
set INV_DASHBOARD_API_TOKEN=your-long-random-token   # optional; LAN-open if unset
uv run investment-dashboard            # serves /api/snapshot, /api/overview, …
# …or standalone:
uv run inv-dashboard-api

# Or export a snapshot file into a consumer-cloud-synced folder (offline phone):
uv run inv-dashboard-export-snapshot --output "%USERPROFILE%\OneDrive\inv-dashboard\mobile_snapshot.json"

# Or publish an encrypted blob to a GitHub release for the v3.0 live-web companion
# (repo/token/passphrase from Settings → Live web companion, or env vars):
uv run inv-dashboard-publish-web            # add --refresh to pull fresh prices first
```

See [`docs/mobile_android_app_proposal.md`](docs/mobile_android_app_proposal.md)
for the full design (Kotlin + Jetpack Compose, cloud-sync delivery, the
JSON contract, and security).

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
├── readmodels/        # UI-agnostic JSON read-models shared by web + mobile
├── api/               # read-only FastAPI JSON API for the mobile companion
├── storage/           # cloud paths, encryption, sidecars, locks, backups
├── tools/             # split-db, repair-sidecar, backup, export-snapshot, publish-web CLIs
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
and [`docs/history/v2.0_split_cloud_security_plan.md`](docs/history/v2.0_split_cloud_security_plan.md)
for the full roadmap. Current status:

- ✅ v1.x — schema, adapters/importers, domain math, repositories/services,
  onboarding, all UI pages, snapshots/cache refresh, Vanguard XLSX import, and
  the v1.5 UI facelift.
- ✅ v2.0 Phase 1–2 — ORM metadata split and tier-specific engines/sessions.
- ✅ v2.0 Phase 3 — cloud-sync-aware path resolution.
- ✅ v2.0 Phase 4 — optional SQLCipher encryption for synced tiers.
- ✅ v2.0 Phase 5 — sidecar guard, single-writer lock, integrity checks, and
  rolling backups.
- ✅ Onboarding/Settings passphrase prompt + recovery file, per-tier Alembic
  version tables, and the Settings “Move ledger…” relocation picker (v2.9.4).

## Security & privacy

This is a **local-first, single-user** app and your real financial data is
designed to never leave your control:

- **Your data stays on your machine.** The SQLite tiers, `.env`, and any real
  brokerage exports are gitignored and never committed. The one anonymized
  fixture set under [`docs/Comparison Files/`](docs/Comparison%20Files/) contains
  **fabricated** figures only — no real positions.
- **The server is LAN-only by design.** It binds `0.0.0.0:8080` so your own
  phone/laptop on the same Wi-Fi can reach it. Do **not** expose it directly to
  the internet; if you must, set `INV_DASHBOARD_API_TOKEN` and put it behind a
  VPN or authenticating reverse proxy first.
- **The only thing ever published is user-encrypted.** The optional live-web
  companion uploads a single `portfolio.enc` blob (AES-256-GCM, PBKDF2-HMAC-
  SHA256 at 600,000 iterations) that is decrypted **in your browser** with a
  passphrase that is never committed, logged, or written to disk. The blob is
  world-downloadable, so choose a long, unique passphrase.
- **Secrets live in your OS keychain**, not in the repo. SQLCipher/publish/
  mobile passphrases are read from the keyring by default; the `INV_DASHBOARD_`
  env keys exist only for headless/CI use.

Found a security problem? Please follow [`SECURITY.md`](SECURITY.md) and use
GitHub's private vulnerability reporting rather than a public issue.

## License

Licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE.md)**.

In short: you may use, copy, modify, and share this software freely for **any
noncommercial purpose** — personal use, hobby projects, study, research, and use
by nonprofits, schools, and government bodies. **Commercial use is not
permitted.** See [`LICENSE.md`](LICENSE.md) for the authoritative terms. This is
a source-available license, not an OSI-approved "open source" license.
