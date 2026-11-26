"""v7.4 native USD fee on a conversion back (USD -> EUR)

* ``fx_conversions.fees_usd`` (Numeric(18,6), nullable): the fee in dollars, taken out of
  the dollars sent; ``NULL`` when the fee is in euros (``fees_eur``) or absent.
* CHECK: a row holds at most one of ``fees_eur`` / ``fees_usd``, and ``fees_usd >= 0``.

Idempotent: added only when absent, dropped on downgrade only when present.

Revision ID: f4d8b2a6c0e1
Revises: e3c7a1f5b9d4 (0031, recurring conversion currency)
Create Date: 2026-11-26 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f4d8b2a6c0e1"
down_revision: str | Sequence[str] | None = "e3c7a1f5b9d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "fx_conversions"
_ONE = "ck_fx_conversions_one_fee_ccy"
_NONNEG = "ck_fx_conversions_fees_usd_nonneg"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in set(inspector.get_table_names()):
        return
    cols = {c["name"] for c in inspector.get_columns(_TABLE)}
    if "fees_usd" not in cols:
        with op.batch_alter_table(_TABLE, schema=None) as batch_op:
            batch_op.add_column(sa.Column("fees_usd", sa.Numeric(18, 6), nullable=True))
            batch_op.create_check_constraint(_NONNEG, "fees_usd IS NULL OR fees_usd >= 0")
            batch_op.create_check_constraint(_ONE, "fees_eur IS NULL OR fees_usd IS NULL")


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in set(inspector.get_table_names()):
        return
    cols = {c["name"] for c in inspector.get_columns(_TABLE)}
    if "fees_usd" in cols:
        checks = {c["name"] for c in inspector.get_check_constraints(_TABLE)}
        with op.batch_alter_table(_TABLE, schema=None) as batch_op:
            for name in (_ONE, _NONNEG):
                if name in checks:
                    batch_op.drop_constraint(name, type_="check")
            batch_op.drop_column("fees_usd")
