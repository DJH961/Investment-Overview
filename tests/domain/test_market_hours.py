"""Unit tests for the US-equity market clock (:mod:`domain.market_hours`)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard.domain.market_hours import (
    feed_is_fresh,
    forex_market_reopen,
    is_forex_market_open,
    is_trading_day,
    is_us_market_holiday,
    is_us_market_holiday_at,
    is_us_market_open,
    last_forex_reopen,
    latest_settled_session_date,
    previous_trading_day,
    regular_session_close,
    regular_session_open,
)

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


@pytest.mark.parametrize(
    "holiday",
    [
        date(2024, 1, 1),  # New Year's Day
        date(2024, 1, 15),  # MLK Day (3rd Monday Jan)
        date(2024, 2, 19),  # Washington's Birthday (3rd Monday Feb)
        date(2024, 3, 29),  # Good Friday
        date(2024, 5, 27),  # Memorial Day (last Monday May)
        date(2024, 6, 19),  # Juneteenth
        date(2024, 7, 4),  # Independence Day
        date(2024, 9, 2),  # Labor Day (1st Monday Sep)
        date(2024, 11, 28),  # Thanksgiving (4th Thursday Nov)
        date(2024, 12, 25),  # Christmas Day
        date(2025, 1, 1),  # New Year's Day (another year)
        date(2026, 4, 3),  # Good Friday 2026
    ],
)
def test_known_nyse_holidays(holiday: date) -> None:
    assert is_us_market_holiday(holiday) is True


@pytest.mark.parametrize(
    "observed",
    [
        date(2021, 12, 31),  # New Year's Day 2022 (Sat) observed Friday before
        date(2021, 7, 5),  # Independence Day 2021 (Sun) observed Monday after
        date(2022, 6, 20),  # Juneteenth 2022 (Sun) observed Monday after
    ],
)
def test_weekend_holidays_use_observed_day(observed: date) -> None:
    assert is_us_market_holiday(observed) is True


def test_juneteenth_not_a_holiday_before_2022() -> None:
    assert is_us_market_holiday(date(2021, 6, 19)) is False


def test_holiday_during_session_hours_is_closed() -> None:
    # Independence Day 2024 (Thursday) at 11:00 ET would be "open" by the
    # weekday-and-clock rule, but the market is closed — must not read live.
    july_4 = datetime(2024, 7, 4, 11, 0, tzinfo=NY)
    assert july_4.weekday() < 5  # a weekday inside 09:30–16:00
    assert is_us_market_open(july_4) is False


def test_regular_weekday_is_not_a_holiday() -> None:
    assert is_us_market_holiday(date(2024, 6, 24)) is False
    assert is_us_market_open(datetime(2024, 6, 24, 10, 0, tzinfo=NY)) is True


def test_is_trading_day() -> None:
    # A plain weekday is a trading day...
    assert is_trading_day(date(2024, 6, 24)) is True  # Monday
    assert is_trading_day(date(2024, 6, 28)) is True  # Friday
    # ...weekends never are...
    assert is_trading_day(date(2024, 6, 29)) is False  # Saturday
    assert is_trading_day(date(2024, 6, 30)) is False  # Sunday
    # ...and a full-day NYSE holiday on a weekday is not, either.
    assert is_trading_day(date(2024, 7, 4)) is False  # Independence Day (Thu)
    assert is_trading_day(date(2024, 1, 1)) is False  # New Year's Day (Mon)


def test_default_now_uses_current_time() -> None:
    # With no argument the helper reads the wall clock; it must not raise and
    # must return a plain bool (the exact value depends on when the suite runs).
    assert isinstance(is_us_market_open(), bool)


class TestFeedIsFresh:
    _NOW = datetime(2024, 6, 24, 18, 0, tzinfo=UTC)

    def test_recent_pull_is_fresh(self) -> None:
        recent = self._NOW - timedelta(seconds=60)
        assert feed_is_fresh(recent, self._NOW) is True

    def test_stale_pull_is_not_fresh(self) -> None:
        # No fresh price for an hour → we cannot access live data, not live.
        stale = self._NOW - timedelta(hours=1)
        assert feed_is_fresh(stale, self._NOW) is False

    def test_no_pull_is_not_fresh(self) -> None:
        assert feed_is_fresh(None, self._NOW) is False

    def test_no_clock_skips_the_gate(self) -> None:
        # now=None means "no clock to judge against": keep legacy behaviour.
        assert feed_is_fresh(None, None) is True
        assert feed_is_fresh(self._NOW - timedelta(days=5), None) is True

    def test_naive_timestamp_is_treated_as_utc(self) -> None:
        naive_recent = self._NOW.replace(tzinfo=None) - timedelta(seconds=30)
        assert feed_is_fresh(naive_recent, self._NOW) is True

    def test_future_timestamp_is_not_fresh(self) -> None:
        # A clock-skew timestamp from the future is not a valid "just landed".
        assert feed_is_fresh(self._NOW + timedelta(hours=1), self._NOW) is False


class TestPreviousTradingDay:
    def test_weekday_rolls_back_one_day(self) -> None:
        # Wednesday → Tuesday.
        assert previous_trading_day(date(2024, 6, 26)) == date(2024, 6, 25)

    def test_monday_rolls_back_to_friday(self) -> None:
        assert previous_trading_day(date(2024, 6, 24)) == date(2024, 6, 21)

    def test_weekend_rolls_back_to_friday(self) -> None:
        assert previous_trading_day(date(2024, 6, 22)) == date(2024, 6, 21)  # Saturday
        assert previous_trading_day(date(2024, 6, 23)) == date(2024, 6, 21)  # Sunday


class TestRegularSessionClose:
    def test_close_is_16_00_exchange_time(self) -> None:
        close = regular_session_close(date(2024, 6, 24))
        assert close == datetime(2024, 6, 24, 16, 0, tzinfo=NY)

    def test_close_converts_to_display_timezone(self) -> None:
        # 16:00 New York (EDT) is 22:00 in Central Europe.
        cet = ZoneInfo("Europe/Berlin")
        close = regular_session_close(date(2024, 6, 24), tz=cet)
        assert (close.hour, close.minute) == (22, 0)
        assert close == datetime(2024, 6, 24, 16, 0, tzinfo=NY)


class TestLatestSettledSessionDate:
    def test_today_counts_only_after_the_close(self) -> None:
        # Monday before 16:00 ET: today's close hasn't settled → previous session.
        assert latest_settled_session_date(datetime(2024, 6, 24, 15, 0, tzinfo=NY)) == date(
            2024, 6, 21
        )
        # At/after 16:00 ET: today's close has settled → today.
        assert latest_settled_session_date(datetime(2024, 6, 24, 16, 0, tzinfo=NY)) == date(
            2024, 6, 24
        )

    def test_before_open_is_the_prior_session(self) -> None:
        # 08:00 ET on a Monday: nothing new today, last settled is Friday.
        assert latest_settled_session_date(datetime(2024, 6, 24, 8, 0, tzinfo=NY)) == date(
            2024, 6, 21
        )

    def test_weekend_rolls_back_to_friday(self) -> None:
        assert latest_settled_session_date(datetime(2024, 6, 22, 12, 0, tzinfo=NY)) == date(
            2024, 6, 21
        )  # Saturday
        assert latest_settled_session_date(datetime(2024, 6, 23, 12, 0, tzinfo=NY)) == date(
            2024, 6, 21
        )  # Sunday

    def test_skips_market_holidays(self) -> None:
        # Thursday 2024-12-26 before the close: 2024-12-25 is Christmas (closed),
        # so the most recent settled session is Tuesday 2024-12-24.
        assert latest_settled_session_date(datetime(2024, 12, 26, 10, 0, tzinfo=NY)) == date(
            2024, 12, 24
        )

    def test_holiday_itself_rolls_back(self) -> None:
        # On Christmas Day (a holiday) there is no settled-today print.
        assert latest_settled_session_date(datetime(2024, 12, 25, 18, 0, tzinfo=NY)) == date(
            2024, 12, 24
        )

    def test_naive_datetime_treated_as_exchange_local(self) -> None:
        assert latest_settled_session_date(datetime(2024, 6, 24, 16, 30)) == date(2024, 6, 24)
        assert latest_settled_session_date(datetime(2024, 6, 24, 9, 0)) == date(2024, 6, 21)

    def test_converts_from_utc(self) -> None:
        # 22:00 UTC is 18:00 ET (after the close) → today has settled.
        assert latest_settled_session_date(datetime(2024, 6, 24, 22, 0, tzinfo=UTC)) == date(
            2024, 6, 24
        )
        # 15:00 UTC is 11:00 ET (mid-session) → still the prior settled session.
        assert latest_settled_session_date(datetime(2024, 6, 24, 15, 0, tzinfo=UTC)) == date(
            2024, 6, 21
        )

    def test_default_now_returns_a_date(self) -> None:
        assert isinstance(latest_settled_session_date(), date)


class TestForexMarketHours:
    """The spot-FX (forex) week: open Sunday 17:00 ET through Friday 17:00 ET, dark
    across the weekend. In June (EDT, UTC-4) 17:00 ET is 21:00 UTC."""

    def test_open_midweek(self) -> None:
        # Wednesday 2024-06-12 15:00 UTC = 11:00 ET.
        assert is_forex_market_open(datetime(2024, 6, 12, 15, 0, tzinfo=UTC)) is True

    def test_friday_before_close_is_open(self) -> None:
        # Friday 2024-06-07 20:00 UTC = 16:00 ET (before the 17:00 ET close).
        assert is_forex_market_open(datetime(2024, 6, 7, 20, 0, tzinfo=UTC)) is True

    def test_friday_after_close_is_shut(self) -> None:
        # Friday 2024-06-07 21:30 UTC = 17:30 ET.
        assert is_forex_market_open(datetime(2024, 6, 7, 21, 30, tzinfo=UTC)) is False

    def test_saturday_is_shut(self) -> None:
        assert is_forex_market_open(datetime(2024, 6, 8, 15, 0, tzinfo=UTC)) is False

    def test_sunday_before_reopen_is_shut(self) -> None:
        # Sunday 2024-06-09 14:00 UTC = 10:00 ET (before the 17:00 ET reopen).
        assert is_forex_market_open(datetime(2024, 6, 9, 14, 0, tzinfo=UTC)) is False

    def test_sunday_after_reopen_is_open(self) -> None:
        # Sunday 2024-06-09 22:00 UTC = 18:00 ET.
        assert is_forex_market_open(datetime(2024, 6, 9, 22, 0, tzinfo=UTC)) is True

    def test_naive_datetime_treated_as_exchange_local(self) -> None:
        # Naive => already exchange time: Saturday 12:00 is shut.
        assert is_forex_market_open(datetime(2024, 6, 8, 12, 0)) is False


class TestForexReopen:
    def test_reopen_from_saturday_is_next_sunday_17_et(self) -> None:
        reopen = forex_market_reopen(datetime(2024, 6, 8, 15, 0, tzinfo=UTC))
        assert reopen == datetime(2024, 6, 9, 17, 0, tzinfo=NY)

    def test_reopen_from_friday_evening_is_the_coming_sunday(self) -> None:
        reopen = forex_market_reopen(datetime(2024, 6, 7, 21, 30, tzinfo=UTC))
        assert reopen == datetime(2024, 6, 9, 17, 0, tzinfo=NY)

    def test_reopen_on_sunday_morning_is_today(self) -> None:
        reopen = forex_market_reopen(datetime(2024, 6, 9, 14, 0, tzinfo=UTC))
        assert reopen == datetime(2024, 6, 9, 17, 0, tzinfo=NY)

    def test_reopen_converts_to_display_timezone(self) -> None:
        reopen = forex_market_reopen(datetime(2024, 6, 8, 15, 0, tzinfo=UTC), tz=UTC)
        assert reopen == datetime(2024, 6, 9, 21, 0, tzinfo=UTC)


class TestLastForexReopen:
    def test_sunday_evening_reopen_is_today(self) -> None:
        last = last_forex_reopen(datetime(2024, 6, 9, 22, 0, tzinfo=UTC))
        assert last == datetime(2024, 6, 9, 17, 0, tzinfo=NY)

    def test_monday_reopen_is_the_prior_sunday(self) -> None:
        last = last_forex_reopen(datetime(2024, 6, 10, 12, 0, tzinfo=UTC))
        assert last == datetime(2024, 6, 9, 17, 0, tzinfo=NY)


class TestRegularSessionOpen:
    def test_open_is_09_30_exchange_time(self) -> None:
        assert regular_session_open(date(2024, 6, 7)) == datetime(2024, 6, 7, 9, 30, tzinfo=NY)

    def test_open_converts_to_display_timezone(self) -> None:
        # 09:30 ET in June (EDT) is 13:30 UTC.
        assert regular_session_open(date(2024, 6, 7), tz=UTC) == datetime(
            2024, 6, 7, 13, 30, tzinfo=UTC
        )


class TestIsUsMarketHolidayAt:
    def test_july_fourth_is_a_holiday(self) -> None:
        # 2024-07-04 (Thursday) 15:00 UTC = 11:00 ET.
        assert is_us_market_holiday_at(datetime(2024, 7, 4, 15, 0, tzinfo=UTC)) is True

    def test_regular_weekday_is_not_a_holiday(self) -> None:
        assert is_us_market_holiday_at(datetime(2024, 6, 12, 15, 0, tzinfo=UTC)) is False

    def test_resolves_to_exchange_local_date(self) -> None:
        # 2024-07-05 01:00 UTC is still 2024-07-04 21:00 ET ⇒ the holiday.
        assert is_us_market_holiday_at(datetime(2024, 7, 5, 1, 0, tzinfo=UTC)) is True
