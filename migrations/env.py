"""Alembic environment.

Imports the app's ORM ``Base.metadata`` and resolves the DB URL from the same
``Settings`` object the rest of the app uses. This keeps migrations honest:
they target the same database the app reads/writes.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from investment_dashboard.config import get_settings
from investment_dashboard.models import ALL_METADATAS, Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Inject the runtime DB URL so the user doesn't have to maintain two configs.
# Programmatic callers (the app boot sequence) may set this before Alembic
# loads env.py; preserve that URL so migrations run against the active ledger
# tier rather than the legacy single-file fallback.
settings = get_settings()
configured_url = config.get_main_option("sqlalchemy.url")
config.set_main_option(
    "sqlalchemy.url",
    configured_url if configured_url and configured_url.strip() else settings.ledger_url,
)

# Until the engine split lands (rework Phase 2), all three storage tiers
# share one SQLite file. Pass the tuple of every tier's ``MetaData`` so
# autogenerate sees every table regardless of which ``Base`` it lives on.
# ``Base`` is kept in scope for backwards compatibility with older
# migration scripts that reference it.
_ = Base
target_metadata = list(ALL_METADATAS)


def _render_item(type_: str, obj: object, autogen_context: object) -> str | bool:
    return False  # use default renderer


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite-friendly migrations.
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
