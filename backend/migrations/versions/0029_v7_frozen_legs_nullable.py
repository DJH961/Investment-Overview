"""v7.4 P19: snapshot EUR columns become nullable (EUR is derived from native USD)

* ``position_snapshots.total_value_eur`` and ``intraday_value.market_value_eur`` drop
  ``NOT NULL``. The stored native USD plus the per-instant ``fx_eur_usd`` (USD per
  1 EUR) next to it are the source; readers derive EUR as ``usd / fx_eur_usd`` when
  the EUR column is ``NULL``.
* The transaction legs (``net_eur``, ``net_usd``, ``fx_rate_to_eur``) were nullable
  already; since 7.4 they are no longer written or read.

Downgrade backfills every ``NULL`` EUR value from ``usd / fx_eur_usd`` before it
restores ``NOT NULL``. A row with no USD value or no rate cannot be backfilled; it is
cache-tier data rebuilt by the snapshot jobs, so it is deleted rather than given a
made-up number.

Idempotent: tables that are absent (another storage tier) are skipped.

Revision ID: d9b3f1a7c2e5
Revises: c4e8a2f6b0d7
Create Date: 2026-11-25 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d9b3f1a7c2e5"
down_revision: str | Sequence[str] | None = "c4e8a2f6b0d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: (table, EUR column, native USD column)
_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("position_snapshots", "total_value_eur", "total_value_usd"),
    ("intraday_value", "market_value_eur", "market_value_usd"),
)


def _present(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    if table not in set(inspector.get_table_names()):
        return False
    return column in {c["name"] for c in inspector.get_columns(table)}


def _set_nullable(table: str, column: str, *, nullable: bool) -> None:
    with op.batch_alter_table(table, schema=None) as batch_op:
        batch_op.alter_column(
            column,
            existing_type=sa.Numeric(precision=18, scale=6),
            nullable=nullable,
        )


def upgrade() -> None:
    for table, eur, _usd in _COLUMNS:
        if _present(table, eur):
            _set_nullable(table, eur, nullable=True)


def downgrade() -> None:
    for table, eur, usd in _COLUMNS:
        if not _present(table, eur):
            continue
        if _present(table, usd) and _present(table, "fx_eur_usd"):
            op.execute(
                f"UPDATE {table} SET {eur} = {usd} / fx_eur_usd "  # noqa: S608 - constants
                f"WHERE {eur} IS NULL AND {usd} IS NOT NULL "
                "AND fx_eur_usd IS NOT NULL AND fx_eur_usd <> 0"
            )
        op.execute(f"DELETE FROM {table} WHERE {eur} IS NULL")  # noqa: S608 - constants
        _set_nullable(table, eur, nullable=False)
