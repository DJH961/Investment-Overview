"""FX-history repository with idempotent upsert (spec §5.6)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import FxHistory


def get_rates(session: Session, *, base: str = "EUR", quote: str = "USD") -> dict[date, Decimal]:
    """Return ``{date: rate}`` for the ``(base, quote)`` pair."""
    stmt = select(FxHistory.date, FxHistory.rate).where(
        FxHistory.base == base, FxHistory.quote == quote
    )
    return {d: r for d, r in session.execute(stmt).all()}


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
) -> int:
    """Idempotent insert of ``{date: rate}``. Returns rows touched."""
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
