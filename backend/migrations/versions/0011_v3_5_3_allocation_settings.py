"""v3.5.3 persist the no-buy distinction and calculator settings on targets

The Calculator lets the user mark funds as **no-buy** (counted toward the target
percentages but never topped up with fresh cash) and pick a rebalance mode plus
display currency. None of that survived *Save as target…*, so loading a saved
allocation re-ticked every fund and forgot the chosen settings. Persist them:

* ``target_allocation_items.no_buy`` — the central no-buy flag per fund.
* ``target_allocations.allow_sell`` — the rebalance toggle (off = buy-only).
* ``target_allocations.display_currency`` — the entry/display currency.

Idempotent + tier-aware: ``target_allocation*`` live in the **config** tier.
Under the default single-file layout Alembic migrates the ledger DB which also
carries the config tables, so the columns are added there. Split-DB / packaged
installs (which ship no Alembic) gain the columns via the boot ``create_all``
guard instead. Each ``ADD COLUMN`` is guarded so a DB already carrying the
column (e.g. created from the current model) is a no-op.

Revision ID: a7d3e1f9c4b6
Revises: f6c2d0a4b8e3
Create Date: 2026-06-22 13:45:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7d3e1f9c4b6"
down_revision: str | Sequence[str] | None = "f6c2d0a4b8e3"
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
        "target_allocations",
        sa.Column("allow_sell", sa.Boolean(), nullable=False, server_default=sa.false()),
        tables,
    )
    _add_column_if_missing(
        inspector,
        "target_allocations",
        sa.Column("display_currency", sa.String(length=3), nullable=True),
        tables,
    )
    _add_column_if_missing(
        inspector,
        "target_allocation_items",
        sa.Column("no_buy", sa.Boolean(), nullable=False, server_default=sa.false()),
        tables,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "target_allocation_items" in tables:
        with op.batch_alter_table("target_allocation_items", schema=None) as batch_op:
            batch_op.drop_column("no_buy")
    if "target_allocations" in tables:
        with op.batch_alter_table("target_allocations", schema=None) as batch_op:
            batch_op.drop_column("display_currency")
            batch_op.drop_column("allow_sell")
