"""v2.10 reclassify Fidelity share distributions as splits

Fidelity exports a stock split / in-kind share distribution as a
``DISTRIBUTION`` row whose ``Type`` is ``Shares`` (blank price, a share
quantity, and an Amount that is the cost-basis value rather than cash that
moved). The action map could only see the action text and booked it as
``dividend_cash``, which both dropped the distributed shares and invented a
phantom cash dividend (e.g. the Schwab SCHK 2-for-1 split).

The parser now classifies the share form as ``split``. This migration repairs
rows already imported under the old behaviour: a Fidelity ``dividend_cash`` row
that carries a non-zero share quantity but no price is a share distribution.
Genuine cash dividends always carry a zero quantity, so they are untouched.

Reclassifying to ``split`` makes ``positions_service`` add the shares with no
cost-basis change (correct for a split: total basis unchanged, share count
rises) and removes the figure from dividend income.

Revision ID: c3f5a8d1b6e2
Revises: a1c7f2d9e3b8
Create Date: 2026-05-31 20:30:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3f5a8d1b6e2"
down_revision: str | Sequence[str] | None = "a1c7f2d9e3b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "transactions" not in set(inspector.get_table_names()):
        return

    # A Fidelity cash-dividend row with a real share quantity and no price is a
    # mis-booked share distribution. Null the money legs (no cash moved) and
    # promote it to a split so the shares are added without inflating income.
    op.execute(
        sa.text(
            "UPDATE transactions SET "
            "kind = 'split', "
            "net_native = NULL, "
            "net_eur = NULL, "
            "net_usd = NULL, "
            "gross_native = NULL, "
            "price_native = NULL "
            "WHERE source = 'import_fidelity_csv' "
            "AND kind = 'dividend_cash' "
            "AND quantity IS NOT NULL AND quantity <> 0 "
            "AND price_native IS NULL"
        )
    )


def downgrade() -> None:
    # Irreversible: the original cash-leg amounts were intentionally cleared as
    # they never represented a real cash movement. Leave the rows as splits.
    pass
