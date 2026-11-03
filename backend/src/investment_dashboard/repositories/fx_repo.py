"""FX-history repository with idempotent upsert (spec §5.6)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.db import memo
from investment_dashboard.models import FxHistory

#: ``source`` of a rate the user entered by hand; refreshes never overwrite it.
MANUAL_SOURCE = "manual"


def get_rates(session: Session, *, base: str = "EUR", quote: str = "USD") -> dict[date, Decimal]:
    """Return ``{date: rate}`` for the ``(base, quote)`` pair."""
    stmt = select(FxHistory.date, FxHistory.rate).where(
        FxHistory.base == base, FxHistory.quote == quote
    )
    # Memoized per session; the copy keeps callers free to mutate their dict.
    return dict(
        memo(session, ("fx_get_rates", base, quote), lambda: dict(session.execute(stmt).all()))
    )


def latest_rate_date(
    session: Session, *, base: str = "EUR", quote: str = "USD", source: str | None = None
) -> date | None:
    stmt = (
        select(FxHistory.date)
        .where(FxHistory.base == base, FxHistory.quote == quote)
        .order_by(FxHistory.date.desc())
        .limit(1)
    )
    if source is not None:
        stmt = stmt.where(FxHistory.source == source)
    return session.scalars(stmt).one_or_none()


def earliest_rate_date(
    session: Session, *, base: str = "EUR", quote: str = "USD", source: str | None = None
) -> date | None:
    """Oldest cached rate date for ``(base, quote)`` (``None`` if empty).

    Mirrors :func:`investment_dashboard.repositories.prices_repo.earliest_price_date`
    so the FX refresh can detect a leading gap and backfill earlier dates. Pass
    ``source`` to scope the lookup to a single provider (e.g. ``"yfinance"``).
    """
    stmt = (
        select(FxHistory.date)
        .where(FxHistory.base == base, FxHistory.quote == quote)
        .order_by(FxHistory.date.asc())
        .limit(1)
    )
    if source is not None:
        stmt = stmt.where(FxHistory.source == source)
    return session.scalars(stmt).one_or_none()


def upsert_rates(
    session: Session,
    rates: Mapping[date, Decimal],
    *,
    base: str = "EUR",
    quote: str = "USD",
    source: str = "frankfurter",
    overwrite_manual: bool = False,
) -> int:
    """Idempotent insert of ``{date: rate}``. Returns rows touched.

    Hand-entered rows (``source == MANUAL_SOURCE``) are kept unless
    ``overwrite_manual``.
    """
    if not rates:
        return 0
    rows: Iterable[dict[str, object]] = [
        {
            "date": d,
            "base": base,
            "quote": quote,
            "rate": r,
            "source": source,
        }
        for d, r in rates.items()
    ]
    stmt = sqlite_insert(FxHistory).values(list(rows))
    stmt = stmt.on_conflict_do_update(
        index_elements=[FxHistory.date, FxHistory.base, FxHistory.quote],
        set_={"rate": stmt.excluded.rate, "source": stmt.excluded.source},
        where=None if overwrite_manual else FxHistory.source != MANUAL_SOURCE,
    )
    result = session.execute(stmt)
    return result.rowcount or len(rates)


def delete_by_source(
    session: Session,
    *,
    base: str = "EUR",
    quote: str = "USD",
    source: str,
) -> int:
    """Delete every ``(base, quote)`` row marked with ``source``. Returns rows removed.

    Used to retire a provider's rows so another source repopulates the dates —
    e.g. dropping a legacy yfinance end-of-day overlay so the ECB/Frankfurter
    backfill re-marks those days.
    """
    result = session.execute(
        delete(FxHistory).where(
            FxHistory.base == base,
            FxHistory.quote == quote,
            FxHistory.source == source,
        )
    )
    return int(result.rowcount or 0)


def list_rates(
    session: Session,
    *,
    base: str = "EUR",
    quote: str = "USD",
    start: date | None = None,
    end: date | None = None,
) -> list[tuple[date, Decimal, str]]:
    """``(date, rate, source)`` rows in ``[start, end]``, oldest first."""
    stmt = select(FxHistory.date, FxHistory.rate, FxHistory.source).where(
        FxHistory.base == base, FxHistory.quote == quote
    )
    if start is not None:
        stmt = stmt.where(FxHistory.date >= start)
    if end is not None:
        stmt = stmt.where(FxHistory.date <= end)
    return [(d, r, s) for d, r, s in session.execute(stmt.order_by(FxHistory.date))]


def get_rate_row(
    session: Session, on: date, *, base: str = "EUR", quote: str = "USD"
) -> tuple[Decimal, str] | None:
    row = session.get(FxHistory, (on, base, quote))
    return None if row is None else (row.rate, row.source)


def delete_rate(session: Session, on: date, *, base: str = "EUR", quote: str = "USD") -> bool:
    result = session.execute(
        delete(FxHistory).where(
            FxHistory.date == on, FxHistory.base == base, FxHistory.quote == quote
        )
    )
    return bool(result.rowcount)
