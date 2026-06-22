"""v3.6.3 record the provider market time on the price cache metadata

The settled-today Daily Growth caption used to date the figure by *when we
pulled* the price, which is redundant with the visible refresh instant. Stamp
*when the price is from* on the exchange instead — the provider's
``regularMarketTime`` (e.g. the moment a mutual fund's NAV published) — by
adding a nullable ``price_market_time`` column to ``price_cache_metadata``.

Idempotent + tier-aware: ``price_cache_metadata`` lives in the **cache** tier.
Under the default single-file layout Alembic migrates the database that also
carries the cache tables, so the column is added there. Split-DB / packaged
installs (which ship no Alembic) gain the column via the boot ``create_all``
guard (``_ensure_added_columns``) instead. The ``ADD COLUMN`` is guarded so a DB
already carrying the column (e.g. created from the current model) is a no-op.

Revision ID: b8e4f2a0c5d7
Revises: b8e4f2a1d7c9
Create Date: 2026-06-22 16:10:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8e4f2a0c5d7"
down_revision: str | Sequence[str] | None = "b8e4f2a1d7c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _add_column_if_missing(
    inspector: sa.Inspector, table: str, column: sa.Column, tables: set[str]
) -> None:
    if table not in tables:
        return
    existing = {col["name"] for col in inspector.get_columns(table)}
    if column.name in existing:
        return
    with op.batch_alter_table(table, schema=None) as batch_op:
        batch_op.add_column(column)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    _add_column_if_missing(
        inspector,
        "price_cache_metadata",
        sa.Column("price_market_time", sa.DateTime(), nullable=True),
        tables,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "price_cache_metadata" in tables:
        with op.batch_alter_table("price_cache_metadata", schema=None) as batch_op:
            batch_op.drop_column("price_market_time")
