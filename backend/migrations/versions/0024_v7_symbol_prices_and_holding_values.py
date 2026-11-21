"""v7.1 symbol prices + holding daily values (cache tier)

* ``intraday_twin_prices`` becomes ``intraday_symbol_prices`` with a ``kind``
  column (``twin`` | ``holding``, default ``twin``); primary key
  ``(symbol, kind, captured_at)``. Existing rows are kept as ``twin`` rows.
* New ``holding_daily_values``: one native-currency row per
  ``(date, instrument_id, account_id)``, rebuilt lazily on read.

Idempotent like 0023: each table is created only when absent, the old twin table
is copied and dropped only when present. The downgrade restores the 0023 schema
(the twin rows go back to ``intraday_twin_prices``; holding rows and the daily
values are cache data and are dropped). v7-only data: nothing to export.

Revision ID: a7c3e9d1b524
Revises: f6b2d8a4c913
Create Date: 2026-11-21 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c3e9d1b524"
down_revision: str | Sequence[str] | None = "f6b2d8a4c913"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD = "intraday_twin_prices"
_NEW = "intraday_symbol_prices"
_VALUES = "holding_daily_values"


def _create_symbol_prices() -> None:
    op.create_table(
        _NEW,
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False, server_default="twin"),
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.Column("price_native", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "kind", "captured_at"),
    )


def _create_twin_prices() -> None:
    op.create_table(
        _OLD,
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.Column("price_native", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "captured_at"),
    )


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _NEW not in tables:
        _create_symbol_prices()
        if _OLD in tables:
            op.execute(
                f"INSERT INTO {_NEW} (symbol, kind, captured_at, price_native) "  # noqa: S608
                f"SELECT symbol, 'twin', captured_at, price_native FROM {_OLD}"
            )
    if _OLD in tables:
        op.drop_table(_OLD)
    if _VALUES not in tables:
        op.create_table(
            _VALUES,
            sa.Column("date", sa.Date(), nullable=False),
            sa.Column("instrument_id", sa.Integer(), nullable=False),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("quantity", sa.Numeric(precision=18, scale=8), nullable=False),
            sa.Column("close_price_native", sa.Numeric(precision=18, scale=6), nullable=False),
            sa.Column("value_native", sa.Numeric(precision=18, scale=6), nullable=False),
            sa.Column("currency", sa.String(length=3), nullable=False),
            sa.Column("net_flow_native", sa.Numeric(precision=18, scale=6), nullable=False),
            sa.Column("dividends_native", sa.Numeric(precision=18, scale=6), nullable=False),
            sa.Column(
                "computed_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.PrimaryKeyConstraint("date", "instrument_id", "account_id"),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _VALUES in tables:
        op.drop_table(_VALUES)
    if _OLD not in tables:
        _create_twin_prices()
        if _NEW in tables:
            op.execute(
                f"INSERT INTO {_OLD} (symbol, captured_at, price_native) "  # noqa: S608
                f"SELECT symbol, captured_at, price_native FROM {_NEW} WHERE kind = 'twin'"
            )
    if _NEW in tables:
        op.drop_table(_NEW)
