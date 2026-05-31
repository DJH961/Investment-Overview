"""Price-cache metadata repository — track per-instrument refresh timestamps."""

from __future__ import annotations

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


def upsert_last_refreshed_at(
    session: Session,
    instrument_id: int,
    when: datetime | None = None,
) -> None:
    when = when or datetime.now(UTC).replace(tzinfo=None)
    stmt = sqlite_insert(PriceCacheMetadata).values(
        instrument_id=instrument_id, last_refreshed_at=when
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[PriceCacheMetadata.instrument_id],
        set_={"last_refreshed_at": stmt.excluded.last_refreshed_at},
    )
    session.execute(stmt)


def delete_for_instrument(session: Session, instrument_id: int) -> None:
    """Forget ``instrument_id``'s refresh timestamp so it is due again."""
    session.execute(
        delete(PriceCacheMetadata).where(PriceCacheMetadata.instrument_id == instrument_id)
    )
