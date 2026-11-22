"""``fx_session_rates`` repository (ledger tier): EUR/USD at each session's open/close."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import FxSessionRate

#: ``(session_date, open_rate, close_rate, source, open_at, close_at)``.
Row = tuple[date, Decimal, Decimal, str, datetime | None, datetime | None]


def list_all(session: Session) -> list[FxSessionRate]:
    """Every stored session, oldest first."""
    return list(session.scalars(select(FxSessionRate).order_by(FxSessionRate.session_date)))


def stored_dates(session: Session) -> set[date]:
    return set(session.scalars(select(FxSessionRate.session_date)))


def insert_missing(session: Session, rows: Iterable[Row]) -> int:
    """Insert rows whose session is not stored yet (a recorded session is never rewritten)."""
    count = 0
    for d, open_rate, close_rate, source, open_at, close_at in rows:
        stmt = (
            sqlite_insert(FxSessionRate)
            .values(
                session_date=d,
                open_rate=open_rate,
                close_rate=close_rate,
                source=source,
                open_at=open_at,
                close_at=close_at,
            )
            .on_conflict_do_nothing(index_elements=["session_date"])
        )
        result = session.execute(stmt)
        count += int(getattr(result, "rowcount", 0) or 0)
    session.flush()
    return count
