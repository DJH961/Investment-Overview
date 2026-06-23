"""Intraday market-component repository — within-day intraday-priced value (EUR).

Cache-tier table backing the Overview "1 Day" graph. Each row stores the EUR
value of the intraday-priced holdings (stocks/ETFs) at a captured instant; the
constant cash + NAV base is reapplied when the curve is rendered (see
:mod:`investment_dashboard.models.intraday_value`). Writes are append-only (one
row per captured instant); reads pull the current session's window and a janitor
prunes anything older. Routed through the cache tier for split-DB layouts (see
:func:`investment_dashboard.db.cache_write_session`).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import IntradayValue


def insert_sample(
    session: Session,
    captured_at: datetime,
    market_value_eur: Decimal,
    fx_eur_usd: Decimal | None = None,
) -> None:
    """Append one intraday market-component sample (idempotent on its timestamp).

    ``fx_eur_usd`` is the EUR→USD spot (USD per 1 EUR) at ``captured_at`` so the
    curve can be re-expressed at the true per-timestamp rate; ``None`` leaves the
    point's rate unknown (the render falls back to today's spot).
    """
    stmt = sqlite_insert(IntradayValue).values(
        captured_at=captured_at,
        market_value_eur=market_value_eur,
        fx_eur_usd=fx_eur_usd,
    )
    # Two captures at the identical instant are a no-op rather than an error.
    stmt = stmt.on_conflict_do_update(
        index_elements=[IntradayValue.captured_at],
        set_={
            "market_value_eur": stmt.excluded.market_value_eur,
            "fx_eur_usd": stmt.excluded.fx_eur_usd,
        },
    )
    session.execute(stmt)


def list_in_range(session: Session, start: datetime, end: datetime) -> list[IntradayValue]:
    """Return samples with ``start <= captured_at <= end``, oldest first."""
    stmt = (
        select(IntradayValue)
        .where(IntradayValue.captured_at >= start)
        .where(IntradayValue.captured_at <= end)
        .order_by(IntradayValue.captured_at)
    )
    return list(session.scalars(stmt).all())


def latest(session: Session) -> IntradayValue | None:
    """Return the most recently captured sample, or ``None`` when empty."""
    stmt = select(IntradayValue).order_by(IntradayValue.captured_at.desc()).limit(1)
    return session.scalars(stmt).first()


def delete_before(session: Session, cutoff: datetime) -> int:
    """Delete samples captured strictly before ``cutoff``. Returns rows removed."""
    result = session.execute(delete(IntradayValue).where(IntradayValue.captured_at < cutoff))
    return int(result.rowcount or 0)
