# Contributing

This is a single-author private project, but future-me deserves clean
ground rules.

## Dev setup

Requires Python 3.12+ and [`uv`](https://docs.astral.sh/uv/) (`pip install
--user uv` on Windows).

```powershell
uv sync --extra dev
uv run pre-commit install
```

## Workflow

1. Branch off `main` with a descriptive kebab-case name.
2. Make changes; keep commits scoped and meaningful.
3. Run the full local quality gate before pushing:

   ```powershell
   uv run ruff check .
   uv run ruff format --check .
   uv run mypy src/investment_dashboard/domain
   uv run pytest
   ```

4. CI runs the same gate on push and PR. Don't merge red.

## Layering rules (enforced by convention, not tooling — yet)

- `domain/` contains pure functions. **No** DB session, **no** HTTP, **no**
  `yfinance`, **no** filesystem I/O. Mypy runs in strict mode here.
- `adapters/` wraps every external thing. Each module returns plain
  dataclasses, never ORM rows.
- `repositories/` is the only layer that imports ORM models. Returns ORM
  rows or domain dataclasses; never raw `dict`s.
- `services/` orchestrates use-cases by composing the layers above.
- `ui/` reads input, calls a service, renders the result. Nothing else.

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
