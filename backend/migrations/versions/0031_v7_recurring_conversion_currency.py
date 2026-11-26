"""v7 recurring conversion currency (EUR converted vs USD arriving)

* ``recurring_plans.currency`` (String(3), nullable): ``'EUR'`` or ``'USD'`` for
  conversion plans; ``NULL`` for buy/deposit plans.

Idempotent: added only when absent, dropped on downgrade only when present.

Revision ID: e3c7a1f5b9d4
Revises: d7a3f1c9e5b2 (0030, hicp_index)
Create Date: 2026-11-26 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e3c7a1f5b9d4"
down_revision: str | Sequence[str] | None = "d7a3f1c9e5b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "recurring_plans"
_CHECK = "ck_recurring_plans_currency"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in set(inspector.get_table_names()):
        return
    cols = {c["name"] for c in inspector.get_columns(_TABLE)}
    if "currency" not in cols:
        with op.batch_alter_table(_TABLE, schema=None) as batch_op:
            batch_op.add_column(sa.Column("currency", sa.String(length=3), nullable=True))
            batch_op.create_check_constraint(
                _CHECK, "currency IS NULL OR currency IN ('EUR', 'USD')"
            )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in set(inspector.get_table_names()):
        return
    cols = {c["name"] for c in inspector.get_columns(_TABLE)}
    if "currency" in cols:
        checks = {c["name"] for c in inspector.get_check_constraints(_TABLE)}
        with op.batch_alter_table(_TABLE, schema=None) as batch_op:
            if _CHECK in checks:
                batch_op.drop_constraint(_CHECK, type_="check")
            batch_op.drop_column("currency")
