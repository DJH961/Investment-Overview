"""v2.2 phase (b) instrument enrichment + display overrides

Two changes, both required by the v2.2 phase (b) auto-detect work:

1.  Add ``'unknown'`` to the ``instruments.asset_class`` CHECK
    constraint. The CSV importer used to hard-code every freshly seen
    symbol as an ``etf`` because the parsers had no taxonomy signal.
    Phase (b) flips the default to ``'unknown'`` so the enrichment
    service (or the user) is the one who eventually classifies the
    row. ``'unknown'`` rows are skipped by the live-price refresh
    loop just like ``cash`` / ``savings``.

2.  Add three nullable display-override columns to
    ``instrument_overrides``:

    * ``name_override`` (String 256) — pretty name the user prefers
      over whatever the importer/enrichment wrote on
      ``instruments.name``.
    * ``asset_class_override`` (String 16) — classification used by
      tables/filters/refresh when the user disagrees with the ledger
      row or it is still ``'unknown'``.
    * ``expense_ratio_override`` (Numeric 7,5) — manual TER for funds
      whose issuer doesn't publish one to yfinance.

    These are *display* overrides; the ledger row stays the source of
    truth and never observes them. The composition rule
    (override → ledger → default) lives in
    :func:`investment_dashboard.services.instrument_enrichment_service.
    effective_instrument`.

Both changes use ``batch_alter_table`` so they work on SQLite (no
native ``ALTER COLUMN`` / ``DROP CONSTRAINT``). The CHECK rewrite
preserves the existing ``ck_instrument_currency_len`` constraint.

Revision ID: 9e4b3f6c2a17
Revises: 8d3a2e5b14c6
Create Date: 2026-05-28 18:30:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9e4b3f6c2a17"
down_revision: str | Sequence[str] | None = "8d3a2e5b14c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_NEW_ASSET_CLASS_CHECK = (
    "asset_class IN ('etf','mutual_fund','stock','cash','savings','unknown')"
)
_OLD_ASSET_CLASS_CHECK = "asset_class IN ('etf','mutual_fund','stock','cash','savings')"


def upgrade() -> None:
    # 1. Widen the CHECK constraint on instruments.asset_class.
    with op.batch_alter_table("instruments", schema=None) as batch_op:
        batch_op.drop_constraint("ck_instrument_asset_class", type_="check")
        batch_op.create_check_constraint(
            "ck_instrument_asset_class",
            _NEW_ASSET_CLASS_CHECK,
        )

    # 2. Add the three display-override columns on instrument_overrides.
    with op.batch_alter_table("instrument_overrides", schema=None) as batch_op:
        batch_op.add_column(sa.Column("name_override", sa.String(length=256), nullable=True))
        batch_op.add_column(
            sa.Column("asset_class_override", sa.String(length=16), nullable=True)
        )
        batch_op.add_column(
            sa.Column("expense_ratio_override", sa.Numeric(precision=7, scale=5), nullable=True)
        )


def downgrade() -> None:
    # 1. Drop the override columns.
    with op.batch_alter_table("instrument_overrides", schema=None) as batch_op:
        batch_op.drop_column("expense_ratio_override")
        batch_op.drop_column("asset_class_override")
        batch_op.drop_column("name_override")

    # 2. Re-narrow the CHECK constraint. Coerce any rows that hold the
    # new ``'unknown'`` enum to ``'etf'`` (the legacy default) so the
    # narrower constraint can be re-applied without violating itself.
    op.execute(
        sa.text("UPDATE instruments SET asset_class = 'etf' WHERE asset_class = 'unknown'")
    )
    with op.batch_alter_table("instruments", schema=None) as batch_op:
        batch_op.drop_constraint("ck_instrument_asset_class", type_="check")
        batch_op.create_check_constraint(
            "ck_instrument_asset_class",
            _OLD_ASSET_CLASS_CHECK,
        )
