"""Data Health "Live EUR/USD rate": warn only when a live rate should exist and does not.

The ECB fixing is each date's official rate, never a fault on its own; the check
fires for a missing, stale or frozen live rate while currencies trade, and for a
missing closing rate over the weekend.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.services import diagnostics_service, fx_service

ET = ZoneInfo("America/New_York")
#: Wednesday 12:00 New York: currencies trade.
OPEN = datetime(2024, 6, 5, 12, 0, tzinfo=ET).astimezone(UTC)
#: Saturday 10:00 New York: the forex market is shut until Sunday 17:00.
SHUT = datetime(2024, 6, 8, 10, 0, tzinfo=ET).astimezone(UTC)


@pytest.fixture(autouse=True)
def _clean() -> object:
    fx_service.clear_live_spot()
    yield
    fx_service.clear_live_spot()


def _check(session: Session, now: datetime) -> diagnostics_service.HealthItem:
    return diagnostics_service._check_fx_live(session, now=now)


def test_open_market_with_a_fresh_moving_rate_is_ok(session: Session) -> None:
    fx_service.set_live_spot(
        "USD",
        Decimal("1.08"),
        observed_on=date(2024, 6, 5),
        observed_at=OPEN - timedelta(minutes=2),
    )
    fx_service.set_live_spot(
        "USD",
        Decimal("1.081"),
        observed_on=date(2024, 6, 5),
        observed_at=OPEN - timedelta(minutes=1),
    )
    assert _check(session, OPEN).severity == "ok"


def test_open_market_without_a_live_rate_warns(session: Session) -> None:
    item = _check(session, OPEN)
    assert item.severity == "warning"
    assert "no live EUR/USD rate" in item.detail


def test_open_market_stale_rate_warns(session: Session) -> None:
    fx_service.set_live_spot(
        "USD", Decimal("1.08"), observed_on=date(2024, 6, 5), observed_at=OPEN - timedelta(hours=1)
    )
    item = _check(session, OPEN)
    assert item.severity == "warning"
    assert "last refreshed" in item.detail


def test_open_market_frozen_rate_warns(session: Session) -> None:
    """Refreshed a minute ago, but the same number for an hour: a frozen feed."""
    fx_service.set_live_spot(
        "USD", Decimal("1.08"), observed_on=date(2024, 6, 5), observed_at=OPEN - timedelta(hours=1)
    )
    fx_service.set_live_spot(
        "USD",
        Decimal("1.08"),
        observed_on=date(2024, 6, 5),
        observed_at=OPEN - timedelta(minutes=1),
    )
    item = _check(session, OPEN)
    assert item.severity == "warning"
    assert "has not moved" in item.detail


def test_weekend_with_fridays_close_is_ok(session: Session) -> None:
    friday_close = datetime(2024, 6, 7, 16, 55, tzinfo=ET).astimezone(UTC)
    fx_service.set_live_spot(
        "USD", Decimal("1.0895"), observed_on=date(2024, 6, 7), observed_at=friday_close
    )
    item = _check(session, SHUT)
    assert item.severity == "ok"
    assert "closed" in item.detail


def test_weekend_without_a_closing_rate_warns(session: Session) -> None:
    assert _check(session, SHUT).severity == "warning"
