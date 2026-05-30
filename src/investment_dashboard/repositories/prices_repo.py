"""Price-history repository with idempotent upsert (spec §5.5)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import PriceHistory


def get_closes_for_instrument(session: Session, instrument_id: int) -> dict[date, Decimal]:
    stmt = select(PriceHistory.date, PriceHistory.close_native).where(
        PriceHistory.instrument_id == instrument_id
    )
    return {d: c for d, c in session.execute(stmt).all()}


def latest_price_date(session: Session, instrument_id: int) -> date | None:
    stmt = (
        select(PriceHistory.date)
        .where(PriceHistory.instrument_id == instrument_id)
        .order_by(PriceHistory.date.desc())
        .limit(1)
    )
    return session.scalars(stmt).one_or_none()


def latest_close(session: Session, instrument_id: int) -> Decimal | None:
    stmt = (
        select(PriceHistory.close_native)
        .where(PriceHistory.instrument_id == instrument_id)
        .order_by(PriceHistory.date.desc())
        .limit(1)
    )
    return session.scalars(stmt).one_or_none()


def upsert_closes(
    session: Session,
    instrument_id: int,
    closes: Mapping[date, Decimal],
    *,
    source: str = "yfinance",
) -> int:
    """Idempotent insert of ``{date: close}`` for ``instrument_id``.

    Uses SQLite's ``ON CONFLICT(...) DO UPDATE`` so re-running the price
    refresh is safe (spec §5.5). Returns the number of rows touched.
    """
    if not closes:
        return 0
    rows: Iterable[dict[str, object]] = [
        {
            "instrument_id": instrument_id,
            "date": d,
            "close_native": c,
            "source": source,
        }
        for d, c in closes.items()
    ]
    stmt = sqlite_insert(PriceHistory).values(list(rows))
    stmt = stmt.on_conflict_do_update(
        index_elements=[PriceHistory.instrument_id, PriceHistory.date],
        set_={"close_native": stmt.excluded.close_native, "source": stmt.excluded.source},
    )
    result = session.execute(stmt)
    return result.rowcount or len(closes)
