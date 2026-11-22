"""v7.3 recurring plans (P14): ``recurring_plans`` and the estimate flags

* ``recurring_plans``: a buy or EUR->USD conversion repeated on a cadence.
* ``transactions`` and ``fx_conversions`` each gain ``estimate_plan_id`` (FK, SET NULL),
  ``estimate_due_date`` and ``is_estimate`` (NOT NULL, default false), with
  UNIQUE(``estimate_plan_id``, ``estimate_due_date``): one generated row per plan and due date.

Idempotent: columns / the table are added only when absent and dropped on downgrade
only when present (restores the 0026 schema).

Revision ID: c5e1a7d3f902
Revises: a7c3e9d1b5f2
Create Date: 2026-11-22 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5e1a7d3f902"
down_revision: str | Sequence[str] | None = "a7c3e9d1b5f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLANS = "recurring_plans"
_TARGETS = ("transactions", "fx_conversions")
_BATCHES = "import_batches"


def _names(table: str) -> tuple[str, str]:
    return (f"fk_{table}_estimate_plan_id_{_PLANS}", f"uq_{table}_estimate_plan_due")


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _PLANS not in tables:
        op.create_table(
            _PLANS,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(length=16), nullable=False),
            sa.Column("unit", sa.String(length=8), nullable=False),
            sa.Column("every", sa.Integer(), nullable=False),
            sa.Column("anchor", sa.Integer(), nullable=True),
            sa.Column("start_date", sa.Date(), nullable=False),
            sa.Column("end_date", sa.Date(), nullable=True),
            sa.Column("paused", sa.Boolean(), server_default=sa.text("0"), nullable=False),
            sa.Column("generated_through", sa.Date(), nullable=True),
            sa.Column("account_id", sa.Integer(), nullable=True),
            sa.Column("instrument_id", sa.Integer(), nullable=True),
            sa.Column("amount", sa.Numeric(precision=18, scale=6), nullable=True),
            sa.Column("shares", sa.Numeric(precision=18, scale=8), nullable=True),
            sa.Column("provider", sa.String(length=16), nullable=True),
            sa.Column("expected_fee", sa.Numeric(precision=18, scale=6), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.text("CURRENT_TIMESTAMP"),
                nullable=False,
            ),
            sa.CheckConstraint("kind IN ('buy', 'deposit', 'conversion')", name="ck_recurring_plans_kind"),
            sa.CheckConstraint(
                "unit IN ('days', 'weeks', 'months')", name="ck_recurring_plans_unit"
            ),
            sa.CheckConstraint("every >= 1", name="ck_recurring_plans_every"),
            sa.CheckConstraint("amount IS NULL OR amount > 0", name="ck_recurring_plans_amount"),
            sa.CheckConstraint("shares IS NULL OR shares > 0", name="ck_recurring_plans_shares"),
            sa.CheckConstraint(
                "provider IS NULL OR provider IN ('wise', 'revolut', 'other')",
                name="ck_recurring_plans_provider",
            ),
            sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
    if _BATCHES in tables:
        batch_cols = {c["name"] for c in inspector.get_columns(_BATCHES)}
        with op.batch_alter_table(_BATCHES, schema=None) as batch_op:
            if "update_images" not in batch_cols:
                batch_op.add_column(sa.Column("update_images", sa.Text(), nullable=True))
            if "updated_count" not in batch_cols:
                batch_op.add_column(
                    sa.Column(
                        "updated_count", sa.Integer(), server_default=sa.text("0"), nullable=False
                    )
                )
    for table in _TARGETS:
        if table not in tables:
            continue
        have = {c["name"] for c in inspector.get_columns(table)}
        if "estimate_plan_id" in have:
            continue
        fk_name, uq_name = _names(table)
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column("estimate_plan_id", sa.Integer(), nullable=True))
            batch_op.add_column(sa.Column("estimate_due_date", sa.Date(), nullable=True))
            batch_op.add_column(
                sa.Column("is_estimate", sa.Boolean(), server_default=sa.text("0"), nullable=False)
            )
            batch_op.create_foreign_key(fk_name, _PLANS, ["estimate_plan_id"], ["id"], ondelete="SET NULL")
            batch_op.create_unique_constraint(uq_name, ["estimate_plan_id", "estimate_due_date"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in _TARGETS:
        if table not in tables:
            continue
        have = {c["name"] for c in inspector.get_columns(table)}
        if "estimate_plan_id" not in have:
            continue
        fk_name, uq_name = _names(table)
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_constraint(uq_name, type_="unique")
            batch_op.drop_constraint(fk_name, type_="foreignkey")
            batch_op.drop_column("is_estimate")
            batch_op.drop_column("estimate_due_date")
            batch_op.drop_column("estimate_plan_id")
    if _BATCHES in tables:
        batch_cols = {c["name"] for c in inspector.get_columns(_BATCHES)}
        with op.batch_alter_table(_BATCHES, schema=None) as batch_op:
            if "updated_count" in batch_cols:
                batch_op.drop_column("updated_count")
            if "update_images" in batch_cols:
                batch_op.drop_column("update_images")
    if _PLANS in tables:
        op.drop_table(_PLANS)
