"""Stall windows are logged, persisted and reported by Data Health."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.services import diagnostics_service, feed_stall_service

T0 = datetime(2026, 11, 5, 17, 11, tzinfo=UTC)
Q = {"VTI": Decimal("364.80")}


@pytest.fixture(autouse=True)
def _fresh_detector() -> Iterator[None]:
    feed_stall_service.reset()
    yield
    feed_stall_service.reset()


def _pull(session: Session, minute: int, quotes: dict[str, Decimal]) -> None:
    now = T0 + timedelta(minutes=minute)
    feed_stall_service.observe_pull(
        session, now=now, market_open=True, quotes=quotes, newest_market_time=now
    )


def test_stall_is_tracked_persisted_and_reported(session: Session) -> None:
    _pull(session, 0, Q)
    for minute in range(1, 6):
        _pull(session, minute, Q)
    assert feed_stall_service.is_stalled()
    assert feed_stall_service.stalled_since() == T0
    current = diagnostics_service._check_price_feed(session)
    assert current.severity == "error"

    _pull(session, 102, {"VTI": Decimal("362.00")})
    assert not feed_stall_service.is_stalled()
    windows = feed_stall_service.windows_between(
        session, T0 - timedelta(hours=1), T0 + timedelta(hours=3), now=T0 + timedelta(hours=3)
    )
    assert windows == [(T0, T0 + timedelta(minutes=102))]


def test_health_lists_recent_windows(session: Session) -> None:
    now = datetime.now(UTC)
    feed_stall_service.record_window(
        session, now - timedelta(days=1, minutes=90), now - timedelta(days=1)
    )
    item = diagnostics_service._check_price_feed(session)
    assert item.severity == "warning"
    assert item.count == 1
    assert "90 min" in item.examples[0]


def test_health_ok_without_stalls(session: Session) -> None:
    assert diagnostics_service._check_price_feed(session).severity == "ok"
