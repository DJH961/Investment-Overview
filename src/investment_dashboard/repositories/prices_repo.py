"""Price-history repository with idempotent upsert (spec §5.5)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from decimal import Decimal

from sqlalchemy import delete, func, select
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


def latest_price_dates(session: Session, instrument_ids: Sequence[int]) -> dict[int, date]:
    """Newest cached print date per instrument in one ``GROUP BY`` query.

    Batched form of :func:`latest_price_date` to avoid N round-trips when the
    refresh inspects every instrument's cached tail. Instruments with no cached
    history are simply absent from the returned mapping.
    """
    if not instrument_ids:
        return {}

    stmt = (
        select(PriceHistory.instrument_id, func.max(PriceHistory.date))
        .where(PriceHistory.instrument_id.in_(instrument_ids))
        .group_by(PriceHistory.instrument_id)
    )
    return {iid: d for iid, d in session.execute(stmt).all()}


def earliest_price_dates(session: Session, instrument_ids: Sequence[int]) -> dict[int, date]:
    """Oldest cached print date per instrument in one ``GROUP BY`` query.

    Batched form of :func:`earliest_price_date`.
    """
    if not instrument_ids:
        return {}

    stmt = (
        select(PriceHistory.instrument_id, func.min(PriceHistory.date))
        .where(PriceHistory.instrument_id.in_(instrument_ids))
        .group_by(PriceHistory.instrument_id)
    )
    return {iid: d for iid, d in session.execute(stmt).all()}


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


def latest_closes(session: Session, instrument_ids: Sequence[int]) -> dict[int, Decimal]:
    """Last known close per instrument in one window query.

    Batched form of :func:`latest_close` so valuing "today" across a whole
    portfolio is a single round-trip instead of one lookup per holding.
    Instruments with no cached history are absent from the mapping.
    """
    if not instrument_ids:
        return {}
    ranked = (
        select(
            PriceHistory.instrument_id,
            PriceHistory.close_native,
            func.row_number()
            .over(
                partition_by=PriceHistory.instrument_id,
                order_by=PriceHistory.date.desc(),
            )
            .label("rn"),
        )
        .where(PriceHistory.instrument_id.in_(instrument_ids))
        .subquery()
    )
    stmt = select(ranked.c.instrument_id, ranked.c.close_native).where(ranked.c.rn == 1)
    return {iid: close for iid, close in session.execute(stmt).all()}


def closes_as_of(
    session: Session, instrument_ids: Sequence[int], as_of: date
) -> dict[int, Decimal]:
    """Most recent close on or before ``as_of`` per instrument in one query.

    Batched form of :func:`close_as_of`: a single window query partitions by
    ``instrument_id`` and keeps each instrument's newest print at or before
    ``as_of``, replacing the per-instrument N+1 that historical valuations
    (YTD/MTD start, period-closing snapshots) otherwise issue. Instruments with
    no print on or before ``as_of`` are absent from the mapping.
    """
    if not instrument_ids:
        return {}
    ranked = (
        select(
            PriceHistory.instrument_id,
            PriceHistory.close_native,
            func.row_number()
            .over(
                partition_by=PriceHistory.instrument_id,
                order_by=PriceHistory.date.desc(),
            )
            .label("rn"),
        )
        .where(
            PriceHistory.instrument_id.in_(instrument_ids),
            PriceHistory.date <= as_of,
        )
        .subquery()
    )
    stmt = select(ranked.c.instrument_id, ranked.c.close_native).where(ranked.c.rn == 1)
    return {iid: close for iid, close in session.execute(stmt).all()}


def instrument_ids_with_nonpositive_close(
    session: Session, instrument_ids: Sequence[int]
) -> set[int]:
    """Instrument ids whose cached history holds a non-positive (≤ 0) close.

    A zero (or negative) close is never a legitimate price for a tradeable
    instrument — yfinance occasionally returns ``0.0`` for a missing print, and
    that bad value then forward-fills through :func:`close_as_of`, silently
    understating every historical valuation that lands on it. Surfacing the
    affected instruments lets the UI flag that the price feed is corrupt so the
    numbers can't be trusted until it is repaired. Money-market / synthetic rows
    have no ``price_history`` rows at all, so they are never returned here.
    """
    if not instrument_ids:
        return set()
    stmt = (
        select(PriceHistory.instrument_id)
        .where(
            PriceHistory.instrument_id.in_(instrument_ids),
            PriceHistory.close_native <= 0,
        )
        .distinct()
    )
    return set(session.scalars(stmt).all())


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


def recent_closes_by_instrument(
    session: Session,
    instrument_ids: Sequence[int],
    *,
    on_or_before: date,
    limit: int = 2,
) -> dict[int, list[tuple[date, Decimal]]]:
    """Per-instrument ``limit`` most recent ``(date, close)`` pairs ≤ ``on_or_before``.

    Batched form of the daily-growth lookup: instead of calling
    :func:`recent_price_dates` + :func:`close_as_of` once per instrument (3
    round-trips × N), a single window query partitions by ``instrument_id`` and
    keeps each instrument's newest ``limit`` prints. The pairs are newest-first
    within each instrument. Instruments with no history are absent.
    """
    if not instrument_ids:
        return {}
    ranked = (
        select(
            PriceHistory.instrument_id,
            PriceHistory.date,
            PriceHistory.close_native,
            func.row_number()
            .over(
                partition_by=PriceHistory.instrument_id,
                order_by=PriceHistory.date.desc(),
            )
            .label("rn"),
        )
        .where(
            PriceHistory.instrument_id.in_(instrument_ids),
            PriceHistory.date <= on_or_before,
        )
        .subquery()
    )
    stmt = (
        select(ranked.c.instrument_id, ranked.c.date, ranked.c.close_native)
        .where(ranked.c.rn <= limit)
        .order_by(ranked.c.instrument_id, ranked.c.date.desc())
    )
    out: dict[int, list[tuple[date, Decimal]]] = {}
    for iid, d, close in session.execute(stmt).all():
        out.setdefault(iid, []).append((d, close))
    return out


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
