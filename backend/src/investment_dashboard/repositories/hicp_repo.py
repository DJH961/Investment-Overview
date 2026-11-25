"""``hicp_index`` repository (cache tier): monthly consumer price index values."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import HicpIndex


def get_series(session: Session, series: str) -> dict[str, Decimal]:
    """``{"YYYY-MM": value}`` for ``series``."""
    stmt = select(HicpIndex.month, HicpIndex.value).where(HicpIndex.series == series)
    return {m: Decimal(v) for m, v in session.execute(stmt).all()}


def latest_month(session: Session, series: str) -> str | None:
    stmt = select(func.max(HicpIndex.month)).where(HicpIndex.series == series)
    return session.scalars(stmt).one_or_none()


def last_fetched_at(session: Session, series: str) -> datetime | None:
    stmt = select(func.max(HicpIndex.fetched_at)).where(HicpIndex.series == series)
    return session.scalars(stmt).one_or_none()


def upsert(
    session: Session, series: str, values: Iterable[tuple[str, Decimal]], *, fetched_at: datetime
) -> int:
    """Insert or update ``(month, value)`` rows; a revised month is overwritten."""
    count = 0
    for month, value in values:
        stmt = sqlite_insert(HicpIndex).values(
            series=series, month=month, value=value, fetched_at=fetched_at
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["series", "month"],
            set_={"value": stmt.excluded.value, "fetched_at": stmt.excluded.fetched_at},
        )
        session.execute(stmt)
        count += 1
    session.flush()
    return count
