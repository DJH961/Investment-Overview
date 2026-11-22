"""v7.3 Wise import: conversion external id, kept dollars, USD-received deposits

* ``fx_conversions.external_id`` (String(64), nullable, unique): the broker's own id
  (the Wise TransferWise ID), used to skip an exact re-import.
* ``fx_conversions.kept_usd`` (Numeric(18,6), NOT NULL default 0, CHECK 0 <= kept <=
  usd_received): dollars kept in the owner's USD account, never sent to the broker.
* ``usd_received_deposits``: a relation marking a deposit as "received in USD (no
  conversion)"; no amounts, no derived currency.

Idempotent: added only when absent, dropped on downgrade only when present.

Revision ID: c4e8a2f6b0d7
Revises: a7c3e9d1b5f2
Create Date: 2026-11-22 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e8a2f6b0d7"
down_revision: str | Sequence[str] | None = "a7c3e9d1b5f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONVERSIONS = "fx_conversions"
_MARKS = "usd_received_deposits"
_UNIQUE = "uq_fx_conversions_external_id"
_CHECK_NONNEG = "ck_fx_conversions_kept_nonneg"
_CHECK_MAX = "ck_fx_conversions_kept_le_received"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _CONVERSIONS in tables:
        have = {c["name"] for c in inspector.get_columns(_CONVERSIONS)}
        with op.batch_alter_table(_CONVERSIONS, schema=None) as batch_op:
            if "external_id" not in have:
                batch_op.add_column(sa.Column("external_id", sa.String(length=64), nullable=True))
                batch_op.create_unique_constraint(_UNIQUE, ["external_id"])
            if "kept_usd" not in have:
                batch_op.add_column(
                    sa.Column(
                        "kept_usd",
                        sa.Numeric(precision=18, scale=6),
                        nullable=False,
                        server_default="0",
                    )
                )
                batch_op.create_check_constraint(_CHECK_NONNEG, "kept_usd >= 0")
                batch_op.create_check_constraint(_CHECK_MAX, "kept_usd <= usd_received")
    if _MARKS not in tables:
        op.create_table(
            _MARKS,
            sa.Column("deposit_txn_id", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.text("CURRENT_TIMESTAMP"),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(["deposit_txn_id"], ["transactions.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("deposit_txn_id"),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _MARKS in tables:
        op.drop_table(_MARKS)
    if _CONVERSIONS in tables:
        have = {c["name"] for c in inspector.get_columns(_CONVERSIONS)}
        with op.batch_alter_table(_CONVERSIONS, schema=None) as batch_op:
            if "kept_usd" in have:
                batch_op.drop_constraint(_CHECK_MAX, type_="check")
                batch_op.drop_constraint(_CHECK_NONNEG, type_="check")
                batch_op.drop_column("kept_usd")
            if "external_id" in have:
                batch_op.drop_constraint(_UNIQUE, type_="unique")
                batch_op.drop_column("external_id")
