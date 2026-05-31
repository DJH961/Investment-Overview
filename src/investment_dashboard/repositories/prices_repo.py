"""Price-history repository with idempotent upsert (spec §5.5)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from decimal import Decimal

from sqlalchemy import delete, select
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


def earliest_price_date(session: Session, instrument_id: int) -> date | None:
    """Oldest cached print date for ``instrument_id`` (``None`` if empty).

    Lets the refresh detect a *leading* gap — cached history that starts later
    than the earliest date the portfolio needs — so the backfill can extend
    backwards instead of only ever appending newer prints.
    """
    stmt = (
        select(PriceHistory.date)
        .where(PriceHistory.instrument_id == instrument_id)
        .order_by(PriceHistory.date.asc())
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


def close_as_of(session: Session, instrument_id: int, as_of: date) -> Decimal | None:
    """Most recent close for ``instrument_id`` on or before ``as_of``.

    Forward-fills across weekends / holidays / sparse history by taking the
    last available print at or before ``as_of``. Returns ``None`` when no
    print exists on or before that date (e.g. the instrument's history starts
    later). This is the as-of analogue of :func:`latest_close` and is what
    historical valuations (YTD start, MTD start, the equity curve) must use so
    that past dates are priced with past prices rather than today's close.
    """
    stmt = (
        select(PriceHistory.close_native)
        .where(
            PriceHistory.instrument_id == instrument_id,
            PriceHistory.date <= as_of,
        )
        .order_by(PriceHistory.date.desc())
        .limit(1)
    )
    return session.scalars(stmt).one_or_none()


def recent_price_dates(
    session: Session,
    instrument_ids: Sequence[int],
    *,
    on_or_before: date,
    limit: int = 2,
) -> list[date]:
    """Most recent distinct print dates across ``instrument_ids`` (newest first).

    Used to find the portfolio's "last completed trading day(s)" so daily
    growth lands on the most recent date *any* held instrument repriced —
    skipping weekends / holidays, and gracefully tolerating the one-day NAV
    lag of mutual funds vs ETFs (the portfolio is then valued consistently on
    each date with forward-filled prices). Returns at most ``limit`` dates.
    """
    if not instrument_ids:
        return []
    stmt = (
        select(PriceHistory.date)
        .where(
            PriceHistory.instrument_id.in_(instrument_ids),
            PriceHistory.date <= on_or_before,
        )
        .distinct()
        .order_by(PriceHistory.date.desc())
        .limit(limit)
    )
    return list(session.scalars(stmt).all())


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


def delete_for_instrument(session: Session, instrument_id: int) -> int:
    """Drop every cached close for ``instrument_id``. Returns rows removed.

    Used when an instrument's ticker is repointed at a different symbol so
    the next refresh repopulates the cache from the new ticker instead of
    forward-filling the old symbol's (now wrong) closes.
    """
    result = session.execute(
        delete(PriceHistory).where(PriceHistory.instrument_id == instrument_id)
    )
    return result.rowcount or 0
