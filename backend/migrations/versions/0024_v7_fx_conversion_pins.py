"""v7.3 conversions: generic pair + provider columns, and deposit pins

* ``fx_conversions`` gains ``from_ccy`` (default EUR), ``to_ccy`` (default USD) and
  ``provider`` (wise / revolut / other, nullable). Existing columns keep their names.
* ``fx_conversion_pins``: the owner's "pay this deposit from that conversion" links.

Idempotent: columns / the table are added only when absent and dropped on downgrade
only when present (restores the 0023 schema).

Revision ID: a7c3e9d1b5f2
Revises: f6b2d8a4c913
Create Date: 2026-11-21 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c3e9d1b5f2"
down_revision: str | Sequence[str] | None = "f6b2d8a4c913"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONVERSIONS = "fx_conversions"
_PINS = "fx_conversion_pins"
_CHECK = "ck_fx_conversions_provider"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _CONVERSIONS in tables:
        have = {c["name"] for c in inspector.get_columns(_CONVERSIONS)}
        with op.batch_alter_table(_CONVERSIONS, schema=None) as batch_op:
            if "from_ccy" not in have:
                batch_op.add_column(
                    sa.Column("from_ccy", sa.String(length=3), nullable=False, server_default="EUR")
                )
            if "to_ccy" not in have:
                batch_op.add_column(
                    sa.Column("to_ccy", sa.String(length=3), nullable=False, server_default="USD")
                )
            if "provider" not in have:
                batch_op.add_column(sa.Column("provider", sa.String(length=16), nullable=True))
                batch_op.create_check_constraint(
                    _CHECK, "provider IS NULL OR provider IN ('wise', 'revolut', 'other')"
                )
    if _PINS not in tables:
        op.create_table(
            _PINS,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("deposit_txn_id", sa.Integer(), nullable=False),
            sa.Column("conversion_id", sa.Integer(), nullable=False),
            sa.Column("usd", sa.Numeric(precision=18, scale=6), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.text("CURRENT_TIMESTAMP"),
                nullable=False,
            ),
            sa.CheckConstraint("usd > 0", name="ck_fx_conversion_pins_usd_pos"),
            sa.ForeignKeyConstraint(["deposit_txn_id"], ["transactions.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["conversion_id"], ["fx_conversions.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("deposit_txn_id", "conversion_id", name="uq_fx_conversion_pins_pair"),
        )
        op.create_index(f"ix_{_PINS}_deposit_txn_id", _PINS, ["deposit_txn_id"])
        op.create_index(f"ix_{_PINS}_conversion_id", _PINS, ["conversion_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _PINS in tables:
        op.drop_index(f"ix_{_PINS}_conversion_id", table_name=_PINS)
        op.drop_index(f"ix_{_PINS}_deposit_txn_id", table_name=_PINS)
        op.drop_table(_PINS)
    if _CONVERSIONS in tables:
        have = {c["name"] for c in inspector.get_columns(_CONVERSIONS)}
        with op.batch_alter_table(_CONVERSIONS, schema=None) as batch_op:
            if "provider" in have:
                batch_op.drop_constraint(_CHECK, type_="check")
                batch_op.drop_column("provider")
            if "to_ccy" in have:
                batch_op.drop_column("to_ccy")
            if "from_ccy" in have:
                batch_op.drop_column("from_ccy")
