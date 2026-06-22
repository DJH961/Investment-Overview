"""Price-cache metadata repository — track per-instrument refresh timestamps."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import PriceCacheMetadata


def get_last_refreshed_at(session: Session, instrument_id: int) -> datetime | None:
    stmt = select(PriceCacheMetadata.last_refreshed_at).where(
        PriceCacheMetadata.instrument_id == instrument_id
    )
    return session.scalars(stmt).one_or_none()


def get_last_refreshed_at_map(
    session: Session, instrument_ids: Sequence[int]
) -> dict[int, datetime]:
    """Refresh timestamp per instrument in one ``IN (...)`` query.

    Batched form of :func:`get_last_refreshed_at` so the due-for-refresh scan
    issues a single query instead of one per instrument. Instruments that have
    never been refreshed are absent from the mapping.
    """
    if not instrument_ids:
        return {}
    stmt = select(PriceCacheMetadata.instrument_id, PriceCacheMetadata.last_refreshed_at).where(
        PriceCacheMetadata.instrument_id.in_(instrument_ids)
    )
    return {iid: ts for iid, ts in session.execute(stmt).all()}


def get_market_time_map(session: Session, instrument_ids: Sequence[int]) -> dict[int, datetime]:
    """Per-instrument *price market time* (``regularMarketTime``) in one query.

    The "market time" is when the served price was last struck on the exchange
    (mutual funds: when the day's NAV published) — *when the price is from*, as
    opposed to ``last_refreshed_at`` (*when we pulled it*). Instruments without a
    recorded market time are absent from the mapping.
    """
    if not instrument_ids:
        return {}
    stmt = select(PriceCacheMetadata.instrument_id, PriceCacheMetadata.price_market_time).where(
        PriceCacheMetadata.instrument_id.in_(instrument_ids)
    )
    return {iid: ts for iid, ts in session.execute(stmt).all() if ts is not None}


def upsert_last_refreshed_at(
    session: Session,
    instrument_id: int,
    when: datetime | None = None,
    *,
    market_time: datetime | None = None,
) -> None:
    when = when or datetime.now(UTC).replace(tzinfo=None)
    values: dict[str, object] = {"instrument_id": instrument_id, "last_refreshed_at": when}
    set_: dict[str, object] = {}
    stmt = sqlite_insert(PriceCacheMetadata)
    set_["last_refreshed_at"] = stmt.excluded.last_refreshed_at
    # Only touch ``price_market_time`` when the caller has a fresh value, so a
    # provider that briefly stops publishing it keeps the last known stamp
    # rather than nulling it on every tick.
    if market_time is not None:
        values["price_market_time"] = market_time
        set_["price_market_time"] = stmt.excluded.price_market_time
    stmt = stmt.values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[PriceCacheMetadata.instrument_id],
        set_=set_,
    )
    session.execute(stmt)


def delete_for_instrument(session: Session, instrument_id: int) -> None:
    """Forget ``instrument_id``'s refresh timestamp so it is due again."""
    session.execute(
        delete(PriceCacheMetadata).where(PriceCacheMetadata.instrument_id == instrument_id)
    )
