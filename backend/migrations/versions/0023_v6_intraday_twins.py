"""v6 intraday twins: ETF twin per instrument + cached twin prices

* ``instrument_overrides.intraday_twin`` (config tier, nullable): the ETF whose
  live price estimates a mutual fund on the 1D graph until its NAV posts.
* ``intraday_twin_prices`` (cache tier): the twins' intraday prices and previous
  session close, so the 1D estimate is rebuilt from stored prices at read time.

Idempotent: a column / table is added only when absent and dropped on downgrade
only when present (restores the 0022 schema). v6-only data:
``inv-dashboard-export-v5`` drops it.

Revision ID: f6b2d8a4c913
Revises: f1c6b8a2d4e7
Create Date: 2026-11-05 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f6b2d8a4c913"
down_revision: str | Sequence[str] | None = "f1c6b8a2d4e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OVERRIDES = "instrument_overrides"
_COLUMN = "intraday_twin"
_PRICES = "intraday_twin_prices"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _OVERRIDES in tables and _COLUMN not in {
        c["name"] for c in inspector.get_columns(_OVERRIDES)
    }:
        with op.batch_alter_table(_OVERRIDES, schema=None) as batch_op:
            batch_op.add_column(sa.Column(_COLUMN, sa.String(length=32), nullable=True))
    if _PRICES not in tables:
        op.create_table(
            _PRICES,
            sa.Column("symbol", sa.String(length=32), nullable=False),
            sa.Column("captured_at", sa.DateTime(), nullable=False),
            sa.Column("price_native", sa.Numeric(precision=18, scale=6), nullable=False),
            sa.PrimaryKeyConstraint("symbol", "captured_at"),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _PRICES in tables:
        op.drop_table(_PRICES)
    if _OVERRIDES in tables and _COLUMN in {c["name"] for c in inspector.get_columns(_OVERRIDES)}:
        with op.batch_alter_table(_OVERRIDES, schema=None) as batch_op:
            batch_op.drop_column(_COLUMN)
