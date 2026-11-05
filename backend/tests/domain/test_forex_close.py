"""last_forex_close: the most recent Friday 17:00 New York close."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.market_hours import is_forex_market_open, last_forex_close

ET = ZoneInfo("America/New_York")


def et(y: int, m: int, d: int, h: int, mi: int = 0) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=ET)


def test_weekend_and_week_examples() -> None:
    friday_close = et(2026, 11, 6, 17)
    assert last_forex_close(et(2026, 11, 7, 12)) == friday_close  # Saturday
    assert last_forex_close(et(2026, 11, 8, 16)) == friday_close  # Sunday before reopen
    assert last_forex_close(et(2026, 11, 6, 17)) == friday_close  # the close itself
    assert last_forex_close(et(2026, 11, 6, 16, 59)) == et(2026, 10, 30, 17)  # Friday before
    assert last_forex_close(et(2026, 11, 4, 9)) == et(2026, 10, 30, 17)  # mid-week


@given(st.datetimes(min_value=datetime(2020, 1, 1), max_value=datetime(2035, 1, 1)))
def test_is_a_past_friday_close_within_a_week(naive: datetime) -> None:
    now = naive.replace(tzinfo=UTC)
    close = last_forex_close(now)
    assert close.weekday() == 4
    assert (close.hour, close.minute) == (17, 0)
    assert close <= now
    assert now - close < timedelta(days=7)
    # While the market is closed nothing newer than that close exists.
    if not is_forex_market_open(now):
        assert now - close < timedelta(days=3)
