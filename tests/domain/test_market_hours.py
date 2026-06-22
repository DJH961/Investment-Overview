"""Unit tests for the US-equity market clock (:mod:`domain.market_hours`)."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard.domain.market_hours import is_us_market_open

NY = ZoneInfo("America/New_York")


@pytest.mark.parametrize(
    ("dt", "expected"),
    [
        # Monday 2024-06-24 inside the regular session.
        (datetime(2024, 6, 24, 10, 0, tzinfo=NY), True),
        # Right at the open / just before the close.
        (datetime(2024, 6, 24, 9, 30, tzinfo=NY), True),
        (datetime(2024, 6, 24, 15, 59, tzinfo=NY), True),
        # Before the open and at/after the close are closed.
        (datetime(2024, 6, 24, 9, 29, tzinfo=NY), False),
        (datetime(2024, 6, 24, 16, 0, tzinfo=NY), False),
        (datetime(2024, 6, 24, 20, 0, tzinfo=NY), False),
        # Saturday / Sunday are always closed.
        (datetime(2024, 6, 22, 12, 0, tzinfo=NY), False),
        (datetime(2024, 6, 23, 12, 0, tzinfo=NY), False),
    ],
)
def test_is_us_market_open(dt: datetime, expected: bool) -> None:
    assert is_us_market_open(dt) is expected


def test_converts_from_other_timezones() -> None:
    # 15:00 UTC on a weekday is 11:00 in New York (EDT) → open.
    utc = ZoneInfo("UTC")
    assert is_us_market_open(datetime(2024, 6, 24, 15, 0, tzinfo=utc)) is True
    # 22:00 UTC is 18:00 New York → closed.
    assert is_us_market_open(datetime(2024, 6, 24, 22, 0, tzinfo=utc)) is False


def test_naive_datetime_treated_as_exchange_local() -> None:
    assert is_us_market_open(datetime(2024, 6, 24, 10, 0)) is True
    assert is_us_market_open(datetime(2024, 6, 24, 8, 0)) is False
