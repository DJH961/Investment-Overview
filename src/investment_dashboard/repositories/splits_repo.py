"""Stock-split repository — idempotent upsert + cumulative-factor lookup.

Splits are cache-tier data sourced from the market-data feed; read/write only
through ``prices_service`` so split-DB installs route to the cache engine.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import PriceSplit


def get_splits_for_instrument(session: Session, instrument_id: int) -> dict[date, Decimal]:
    """Return ``{date: ratio}`` of every cached split for ``instrument_id``."""
    stmt = select(PriceSplit.date, PriceSplit.ratio).where(
        PriceSplit.instrument_id == instrument_id
    )
    return {d: r for d, r in session.execute(stmt).all()}


def instrument_ids_with_splits(session: Session, instrument_ids: Sequence[int]) -> set[int]:
    """Subset of ``instrument_ids`` that have at least one cached split.

    Lets a caller tell "the feed says this instrument never split" (empty,
    trust a unit factor) apart from "no split data has been fetched yet"
    (fall back to the ledger ``split`` rows) at the instrument level.
    """
    if not instrument_ids:
        return set()
    stmt = (
        select(PriceSplit.instrument_id)
        .where(PriceSplit.instrument_id.in_(instrument_ids))
        .distinct()
    )
    return set(session.scalars(stmt).all())


def cumulative_factor_after(session: Session, instrument_id: int, as_of: date) -> Decimal:
    """Product of every split ratio strictly **after** ``as_of``.

    yfinance back-adjusts an instrument's whole price history by each split, so
    valuing a date before a split requires scaling the share count by this
    factor to match the adjusted close. Returns ``Decimal(1)`` when no split
    falls after ``as_of`` (including instruments that never split).
    """
    stmt = select(PriceSplit.ratio).where(
        PriceSplit.instrument_id == instrument_id,
        PriceSplit.date > as_of,
    )
    factor = Decimal(1)
    for (ratio,) in session.execute(stmt).all():
        if ratio and ratio > 0:
            factor *= ratio
    return factor


def upsert_splits(
    session: Session,
    instrument_id: int,
    splits: Mapping[date, Decimal],
    *,
    source: str = "yfinance",
) -> int:
    """Idempotent insert of ``{date: ratio}`` for ``instrument_id``.

    Uses SQLite ``ON CONFLICT(...) DO UPDATE`` so re-running the split refresh
    is safe. Returns the number of rows touched.
    """
    if not splits:
        return 0
    rows: Iterable[dict[str, object]] = [
        {
            "instrument_id": instrument_id,
            "date": d,
            "ratio": r,
            "source": source,
        }
        for d, r in splits.items()
    ]
    stmt = sqlite_insert(PriceSplit).values(list(rows))
    stmt = stmt.on_conflict_do_update(
        index_elements=[PriceSplit.instrument_id, PriceSplit.date],
        set_={"ratio": stmt.excluded.ratio, "source": stmt.excluded.source},
    )
    result = session.execute(stmt)
    return result.rowcount or len(splits)


def delete_for_instrument(session: Session, instrument_id: int) -> int:
    """Drop every cached split for ``instrument_id``. Returns rows removed.

    Used when an instrument's ticker is repointed so stale corporate actions
    for the old symbol can't keep mis-adjusting the new one.
    """
    result = session.execute(delete(PriceSplit).where(PriceSplit.instrument_id == instrument_id))
    return result.rowcount or 0
