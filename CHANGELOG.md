# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

- **0.x** — pre-UI scaffolding milestones. The app does **not** yet present a
  usable web UI.
- **1.0.0** — first release with a runnable UI: end-to-end flow from CSV
  import / manual entry through `/overview` with real XIRR/TWR numbers.
- Subsequent **minor** bumps add features; **patch** bumps are bugfixes only.

## [Unreleased]

_Nothing yet._

## [0.6.0] — 2026-05-26

### Added — `/transactions` page
- `ui/pages/_ledger_query.py`: `LedgerFilters` dataclass + `list_ledger_rows`
  helper that joins `Transaction → Account → Instrument` and formats
  Decimals for AG-Grid. Unit-testable without NiceGUI.
- `ui/pages/transactions.py` upgraded from stub to a functional page:
  - AG-Grid ledger (10 columns: Date · Account · Kind · Symbol · Qty ·
    Price · Fees · Net · Net EUR · Source), paginated, resizable.
  - Filter chips: account dropdown, kind dropdown, symbol text input.
  - **+ New Transaction** modal — manual entry with account/kind/date/
    symbol/qty/price/fees/net/description.
  - **Import CSV** modal — broker dropdown, account picker, file upload
    that pipes content into `services.importer_service.import_csv` and
    reports inserted / duplicates / sweeps / unknown actions.
- 4 new tests covering `list_ledger_rows` filtering + ordering. 147
  total pass.

## [0.5.0] — 2026-05-26

### Added — UI shell
- `ui/theme.py`: Wong colorblind-safe palette (gain=blue `#0072B2`,
  loss=orange `#E69F00`) plus a registered Plotly `colorblind` template
  set as default. `color_for_signed`/`arrow_for_signed` helpers for
  redundant directional cues.
- `ui/layout.py`: `page_frame()` context manager rendering a consistent
  header + sidebar across every page. `NAV_ITEMS` covers the seven
  spec'd pages (Overview / Deposits / Transactions / Monthly / Yearly /
  Calculator / Settings).
- `ui/copy/tooltips.py`: single source of truth for tooltip wording, all
  copy ≤ 3 sentences (spec §10).
- `ui/components/`: `kpi_card` and `tooltip_label` reusable components.
- `ui/pages/`: scaffolded page modules for all seven routes; each module
  exposes a `register()` function and a `PATH` constant.
- `boot.py`: idempotent boot sequence — Alembic upgrade → Plotly template
  registration → best-effort FX refresh → best-effort price refresh.
  `skip_network=True` for offline development.
- `main.py` rewired to run the boot sequence and register all pages
  before `ui.run()`. `/` redirects to `/overview`.
- 11 new tests (palette, tooltip copy length budget, boot offline
  short-circuit, nav coverage). 143 total pass.

## [0.4.0] — 2026-05-26

### Added — CSV importers
- `adapters/importer_types.py`: shared `ParsedTransactionRow` dataclass
  and `UnknownActionError`.
- `adapters/fidelity/`:
  - `action_map.py` mapping Fidelity Action substrings to ledger kinds
    (spec §5.1).
  - `parser.py` reading the Fidelity activity-download CSV, skipping
    disclaimer preamble, recomputing prices to handle the May-2024
    2-decimal change, generating sha256 `external_id` for dedup.
- `adapters/vanguard/`:
  - `action_map.py` mapping Vanguard transaction types, including the
    explicit drop of `Sweep In`/`Sweep Out` rows (spec §5.2).
  - `parser.py` with sweep counting and sign-convention enforcement
    (sells get negated quantity).
- `services/importer_service.py`: parser-agnostic glue that resolves
  symbols via `instruments_repo.get_or_create`, looks up FX with
  forward-fill, and writes via savepoint-aware
  `transactions_repo.insert_transaction` for idempotent re-import.
- `repositories/transactions_repo.insert_transaction` now uses a
  SAVEPOINT so duplicate inserts don't roll back the surrounding
  transaction.
- 36 new tests, two sample CSV fixtures, 132 total tests pass.

## [0.3.0] — 2026-05-26

### Added — repositories + services
- `repositories/`:
  - `accounts_repo`: CRUD + filter by broker.
  - `instruments_repo`: `get_or_create()` for CSV importers.
  - `transactions_repo`: filtered listing (by account / instrument /
    kind / date range) + dedup-on-`external_id` insert.
  - `prices_repo` and `fx_repo`: idempotent SQLite
    `ON CONFLICT … DO UPDATE` upserts.
  - `allocations_repo`: target-allocation CRUD with `set_active()` flip.
- `services/`:
  - `fx_service`: incremental Frankfurter backfill + EUR→quote lookup
    with forward-fill on weekends/holidays.
  - `prices_service`: per-instrument incremental yfinance refresh,
    skipping synthetic cash/savings tickers.
  - `positions_service`: rolls up the ledger into per-instrument
    holdings with cost basis, current price, and EUR-converted value;
    plus `compute_cash_balance` and `total_portfolio_value`.
  - `metrics_service`: assembles cashflow streams from the ledger and
    calls the domain layer for portfolio XIRR, YTD XIRR, total growth
    %, capital gain, and YTD growth %.
- 15 new tests across repos and services; 96 tests pass overall.

## [0.2.0] — 2026-05-26

### Added — Phase 2 domain math layer
- `domain/currency.py`: `native_to_eur`, `eur_to_native`, and
  `lookup_rate_with_forward_fill` (weekend / holiday inheritance) — all
  Decimal-based.
- `domain/returns.py`:
  - `Cashflow` and `DailyValuation` dataclasses.
  - `xirr()` via Newton-Raphson with a bisection fallback on
    `[-0.9999, 100.0]`; handles degenerate same-sign streams (returns
    `None`) and non-convergence.
  - `twr()` daily-snapshot time-weighted return (spec §6.3).
  - `cagr()`, `annualize_return()`, `total_growth_pct()`, `capital_gain()`.
- `domain/risk.py`: `annualized_volatility`, `sharpe_ratio`,
  `sortino_ratio`, `max_drawdown`, `best_worst_month`,
  `monthly_win_rate`, `beta`, `alpha` (spec §6.6).
- `domain/allocation.py`: `plan_rebalance()` — buy-only rebalance planner
  with proportional scaling and floored- or fractional-share modes
  (spec §6.8).
- 60 new unit tests under `tests/domain/`, including a self-verifying NPV
  check on an irregular cashflow stream.
- Ruff config: ignore `RUF002`/`RUF003` (mathematical Unicode in
  docstrings is intentional), and relax `PLR0911`/`PLR0912` in
  `domain/returns.py` (XIRR is inherently branchy).

## [0.1.0] — 2026-05-26

### Added — Phase 0 + 1 scaffolding
- Project bootstrap with `uv`, `pyproject.toml`, `.python-version`, `.editorconfig`,
  `.env.example`, `.pre-commit-config.yaml`, and extended `.gitignore`.
- Layered package skeleton under `src/investment_dashboard/`:
  `domain/`, `adapters/`, `repositories/`, `services/`, `ui/`, `models/`.
- `config.py` (pydantic-settings, Windows-aware default DB path), `db.py`
  (SQLite WAL pragmas + session factory), `logging.py`, and a NiceGUI
  smoke entry point `main.py` bound to `0.0.0.0:8080`.
- All ORM models from spec §4: `accounts`, `instruments`, `transactions`
  (with `kind` and `source` enums, `unique(account_id, external_id)`, and
  date/instrument indexes), `price_history`, `fx_history`,
  `target_allocations`, `target_allocation_items`, `app_config`.
- Alembic configured against the app's `Settings.db_url` with an autogenerated
  baseline migration (`0001_initial_schema.py`) using batch operations for
  SQLite compatibility.
- Frankfurter FX adapter (`adapters/frankfurter_client.py`) with `fetch_rates`
  and `fetch_latest`, typed `FrankfurterError`, Decimal precision preserved.
- yfinance market-data adapter (`adapters/yfinance_client.py`) with
  `auto_adjust=False`, batched downloads, graceful handling of empty frames
  and missing symbols, Decimal returns.
- Pytest test suite: in-memory SQLite fixture, schema round-trip tests, FK
  enforcement check, unique-constraint check, mocked-HTTP tests for both
  adapters via `respx` and `monkeypatch`, plus opt-in `@pytest.mark.network`
  smokes (skipped unless `--run-network`).
- GitHub Actions CI: ruff lint + format check, mypy (strict on `domain/`),
  pytest with coverage.
- Docs: `README.md` (quickstart + architecture diagram), `CONTRIBUTING.md`,
  `docs/architecture.md`.

[Unreleased]: https://github.com/DJH961/Investment-Overview/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/DJH961/Investment-Overview/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/DJH961/Investment-Overview/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/DJH961/Investment-Overview/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DJH961/Investment-Overview/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DJH961/Investment-Overview/releases/tag/v0.1.0
