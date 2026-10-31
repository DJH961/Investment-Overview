"""Tests for the cache-tier orphan janitor."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import (
    Instrument,
    PriceCacheMetadata,
    PriceHistory,
)
from investment_dashboard.services.cache_janitor import cleanup_orphan_cache_rows


def test_janitor_drops_only_orphans(session: Session) -> None:
    live = Instrument(symbol="VTI", name="Total US", asset_class="etf", native_currency="USD")
    session.add(live)
    session.flush()

    # Live cache rows.
    session.add(
        PriceHistory(
            instrument_id=live.id,
            date=date(2024, 1, 1),
            close_native=Decimal("100.00"),
        )
    )
    session.add(PriceCacheMetadata(instrument_id=live.id, last_refreshed_at=datetime.now(UTC)))
    # Orphan cache rows for a deleted instrument id 9999.
    session.add(
        PriceHistory(
            instrument_id=9999,
            date=date(2024, 1, 1),
            close_native=Decimal("1.00"),
        )
    )
    session.add(PriceCacheMetadata(instrument_id=9999, last_refreshed_at=datetime.now(UTC)))
    session.flush()

    deleted = cleanup_orphan_cache_rows(session, session)
    assert deleted["price_history"] == 1
    assert deleted["price_cache_metadata"] == 1
    assert "fx_history" in deleted

    remaining_prices = session.query(PriceHistory).all()
    assert len(remaining_prices) == 1
    assert remaining_prices[0].instrument_id == live.id


def test_janitor_no_op_when_clean(session: Session) -> None:
    live = Instrument(symbol="VTI", name="Total US", asset_class="etf", native_currency="USD")
    session.add(live)
    session.flush()
    session.add(
        PriceHistory(
            instrument_id=live.id,
            date=date(2024, 1, 1),
            close_native=Decimal("100.00"),
        )
    )
    session.flush()
    deleted = cleanup_orphan_cache_rows(session, session)
    assert deleted["price_history"] == 0
    assert deleted["price_cache_metadata"] == 0
