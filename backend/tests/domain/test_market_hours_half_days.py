"""NYSE half-day sessions (B-018): 13:00 ET close from an explicit per-year table."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain import feed_stall
from investment_dashboard.domain.market_hours import (
    EARLY_CLOSE_DAYS,
    is_early_close_day,
    is_trading_day,
    is_us_market_open,
    latest_settled_session_date,
    regular_session_close,
    session_close,
)

NY = ZoneInfo("America/New_York")


def test_table_matches_nyse_calendar_2026_2029() -> None:
    """The half days published by the NYSE for 2026-2029.

    2026: 27 Nov (day after Thanksgiving), 24 Dec (Thu); 3 Jul is the observed
    Independence Day, so no half day. 2027: 26 Nov only (3 Jul is a Saturday,
    24 Dec the observed Christmas). 2028: 3 Jul (Mon), 24 Nov (24 Dec is a
    Sunday). 2029: 3 Jul (Tue), 23 Nov, 24 Dec (Mon).
    """
    assert date(2026, 11, 27) in EARLY_CLOSE_DAYS
    assert date(2026, 12, 24) in EARLY_CLOSE_DAYS
    assert date(2026, 7, 3) not in EARLY_CLOSE_DAYS
    assert date(2026, 7, 2) not in EARLY_CLOSE_DAYS
    assert date(2027, 12, 24) not in EARLY_CLOSE_DAYS
    assert date(2027, 12, 23) not in EARLY_CLOSE_DAYS
    assert {d for d in EARLY_CLOSE_DAYS if d.year == 2028} == {
        date(2028, 7, 3),
        date(2028, 11, 24),
    }
    assert {d for d in EARLY_CLOSE_DAYS if d.year == 2029} == {
        date(2029, 7, 3),
        date(2029, 11, 23),
        date(2029, 12, 24),
    }


def test_every_half_day_is_a_trading_day() -> None:
    for day in EARLY_CLOSE_DAYS:
        assert is_trading_day(day), day
        assert is_early_close_day(day)
        assert session_close(day) == time(13, 0)


def test_day_after_thanksgiving_2026_closes_at_13() -> None:
    """27 Nov 2026: 12:59 ET open, 13:00 / 13:01 ET closed and settled."""
    assert is_us_market_open(datetime(2026, 11, 27, 12, 59, tzinfo=NY)) is True
    assert is_us_market_open(datetime(2026, 11, 27, 13, 0, tzinfo=NY)) is False
    assert is_us_market_open(datetime(2026, 11, 27, 13, 1, tzinfo=NY)) is False
    assert latest_settled_session_date(datetime(2026, 11, 27, 13, 1, tzinfo=NY)) == date(
        2026, 11, 27
    )
    # Before the early close the settled session is the one before Thanksgiving.
    assert latest_settled_session_date(datetime(2026, 11, 27, 12, 59, tzinfo=NY)) == date(
        2026, 11, 25
    )
    assert regular_session_close(date(2026, 11, 27)) == datetime(2026, 11, 27, 13, 0, tzinfo=NY)


def test_christmas_eve_2026_closes_at_13() -> None:
    assert is_us_market_open(datetime(2026, 12, 24, 12, 30, tzinfo=NY)) is True
    assert is_us_market_open(datetime(2026, 12, 24, 14, 0, tzinfo=NY)) is False


def test_regular_day_still_closes_at_16() -> None:
    assert session_close(date(2026, 11, 25)) == time(16, 0)
    assert is_us_market_open(datetime(2026, 11, 30, 15, 59, tzinfo=NY)) is True


def test_feed_stall_detector_stays_quiet_after_early_close() -> None:
    """Frozen quotes from 13:00 to 16:00 ET on a half day must not raise a stall.

    The detector folds ``market_open`` from :func:`is_us_market_open`; after the
    13:00 close it is False, so no stall starts however long prices stay flat.
    """
    state = feed_stall.StallState()
    quotes = {"FAKE1": Decimal("100")}
    start = datetime(2026, 11, 27, 13, 1, tzinfo=NY)
    for minute in range(0, 180, 1):
        now = start + timedelta(minutes=minute)
        state, change = feed_stall.observe(
            state,
            now=now,
            market_open=is_us_market_open(now),
            quotes=quotes,
            newest_market_time=datetime(2026, 11, 27, 13, 0, tzinfo=NY),
        )
        assert change.started is None
    assert state.stalled_since is None


@given(st.dates(min_value=date(2026, 1, 1), max_value=date(2029, 12, 31)))
def test_open_iff_before_session_close(day: date) -> None:
    """Property: on a trading day the market is open exactly until ``session_close``."""
    close = session_close(day)
    before = datetime.combine(day, close, tzinfo=NY) - timedelta(minutes=1)
    at = datetime.combine(day, close, tzinfo=NY)
    if is_trading_day(day):
        assert is_us_market_open(before) is True
        assert is_us_market_open(at) is False
        assert latest_settled_session_date(at) == day
        assert latest_settled_session_date(before) < day
    else:
        assert is_us_market_open(before) is False


@pytest.mark.parametrize("day", sorted(EARLY_CLOSE_DAYS))
def test_half_days_settle_at_13(day: date) -> None:
    assert latest_settled_session_date(datetime.combine(day, time(13, 1), tzinfo=NY)) == day
