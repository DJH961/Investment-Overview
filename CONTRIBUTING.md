# Contributing

This is a single-author private project, but future-me deserves clean
ground rules. **The rules themselves live in [`AGENTS.md`](AGENTS.md)** (currency,
architecture, git flow, changelog, releases, quality gate); this file covers dev
setup and the how-to.

## Dev setup

Requires Python 3.12+ and [`uv`](https://docs.astral.sh/uv/) (`pip install
--user uv` on Windows).

```powershell
uv sync --extra dev
uv run pre-commit install
```

## Workflow

1. Features and risky changes: a descriptive kebab-case branch and a PR.
   Small or urgent fixes may go straight to `main` once the gate passes.
2. Make changes; keep commits scoped and meaningful. Add a CHANGELOG entry; features
   and fixes are released in the same PR (see the release rule in `AGENTS.md`).
3. Run the full local quality gate (listed in [`AGENTS.md`](AGENTS.md#workflow))
   before pushing. In short:

   ```powershell
   uv run ruff format .
   uv run ruff check . --fix
   uv run mypy src/investment_dashboard/domain
   uv run pytest
   cd web; npm run typecheck; npm run test
   ```

4. CI runs the same gate on push and PR. Don't leave `main` red.

Layering, the cache-tier rule, the currency rule and test expectations are in
[`AGENTS.md`](AGENTS.md).

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
