# Contributing

This is a single-author private project, but future-me deserves clean
ground rules.

> 💵 **Currency:** USD is the canonical backend currency (computation, storage, reconciliation, exports); EUR is presentation-only (`usd ÷ fx`) and the default frontend toggle. Never code EUR as the base.

## Dev setup

Requires Python 3.12+ and [`uv`](https://docs.astral.sh/uv/) (`pip install
--user uv` on Windows).

```powershell
uv sync --extra dev
uv run pre-commit install
```

## Workflow

1. For this personal project, pushing directly to `main` is OK after the
    local quality gate passes. Use a descriptive kebab-case branch when a
    change benefits from review, experimentation or a safer staging area.
2. Make changes; keep commits scoped and meaningful.
3. Run the full local quality gate before pushing:

   ```powershell
   uv run ruff check .
   uv run ruff format --check .
   uv run mypy src/investment_dashboard/domain
   uv run pytest
   ```

4. CI runs the same gate on push and PR. Don't leave `main` red.

## Layering rules (enforced by convention, not tooling — yet)

- `domain/` contains pure functions. **No** DB session, **no** HTTP, **no**
  `yfinance`, **no** filesystem I/O. Mypy runs in strict mode here.
- `adapters/` wraps every external thing. Each module returns plain
  dataclasses, never ORM rows.
- `repositories/` is the only layer that imports ORM models. Returns ORM
  rows or domain dataclasses; never raw `dict`s.
- `services/` orchestrates use-cases by composing the layers above.
- `ui/` reads input, renders the result, and calls a service for any mutation
  or multi-step use-case. It may also read ledger-tier repositories directly
  for simple queries (e.g. `transactions_repo`, `instruments_repo`).
- **Cache-tier data (prices, FX, snapshots) is read/written only through its
  service** (`prices_service`, `fx_service`, `snapshots_service`), which routes
  to the cache engine via `db.cache_read_session` / `cache_write_session`.
  Never call `prices_repo` / `fx_repo` / `snapshots_repo` directly on a ledger
  session — it silently returns empty under a split-DB layout. See
  "Storage tiers" in [`docs/architecture.md`](docs/architecture.md).

## Tests

- New code in `domain/` is property-tested where the math admits it
  (`hypothesis`), plus a handful of golden-value tests against Excel-known
  answers.
- Adapters are unit-tested with mocked HTTP (`respx`) or monkey-patched
  downloaders. Live-API smoke tests are marked `@pytest.mark.network` and
  skipped by default; run with `pytest --run-network`.

## Migrations

Generate after changing models:

```powershell
uv run alembic revision --autogenerate -m "describe change"
uv run alembic upgrade head
```

SQLite is unforgiving about `ALTER TABLE`; we use `render_as_batch=True` in
`migrations/env.py` so Alembic emits the table-rebuild dance automatically.

## Commit hygiene

Conventional-style prefixes encouraged: `feat:`, `fix:`, `chore:`, `test:`,
`docs:`, `refactor:`. Keep the subject line ≤ 72 chars.
