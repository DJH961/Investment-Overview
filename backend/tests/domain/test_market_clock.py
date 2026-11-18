"""Market clock: next open / current open / next close (aware UTC in and out)."""

from __future__ import annotations

from datetime import UTC, datetime

from investment_dashboard.domain.market_hours import (
    current_session_open,
    last_session_close,
    next_session_close,
    next_session_open,
)


def utc(y: int, mo: int, d: int, h: int = 0, mi: int = 0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


def test_mid_session_regular_day() -> None:
    now = utc(2026, 11, 17, 16, 0)  # Tue 11:00 ET (EST)
    assert current_session_open(now) == utc(2026, 11, 17, 14, 30)
    assert next_session_open(now) == utc(2026, 11, 18, 14, 30)
    assert next_session_close(now) == utc(2026, 11, 17, 21, 0)


def test_naive_is_utc() -> None:
    assert next_session_close(datetime(2026, 11, 17, 16, 0)) == utc(2026, 11, 17, 21, 0)


def test_before_open_and_after_close() -> None:
    early = utc(2026, 11, 17, 12, 0)
    assert current_session_open(early) is None
    assert next_session_open(early) == utc(2026, 11, 17, 14, 30)
    assert next_session_close(early) == utc(2026, 11, 17, 21, 0)
    late = utc(2026, 11, 17, 22, 0)
    assert next_session_open(late) == utc(2026, 11, 18, 14, 30)
    assert next_session_close(late) == utc(2026, 11, 18, 21, 0)


def test_exactly_at_open_is_strictly_after() -> None:
    now = utc(2026, 11, 17, 14, 30)
    assert current_session_open(now) == now
    assert next_session_open(now) == utc(2026, 11, 18, 14, 30)


def test_half_day_open_and_after_close() -> None:
    now = utc(2026, 11, 27, 16, 0)  # Fri after Thanksgiving, 11:00 ET
    assert current_session_open(now) == utc(2026, 11, 27, 14, 30)
    assert next_session_close(now) == utc(2026, 11, 27, 18, 0)
    after = utc(2026, 11, 27, 18, 30)  # past 13:00 ET
    assert current_session_open(after) is None
    assert next_session_open(after) == utc(2026, 11, 30, 14, 30)
    assert next_session_close(after) == utc(2026, 11, 30, 21, 0)


def test_thanksgiving_skipped() -> None:
    wed_evening = utc(2026, 11, 25, 23, 0)
    assert next_session_open(wed_evening) == utc(2026, 11, 27, 14, 30)
    assert next_session_close(wed_evening) == utc(2026, 11, 27, 18, 0)
    thu = utc(2026, 11, 26, 15, 0)
    assert current_session_open(thu) is None
    assert next_session_open(thu) == utc(2026, 11, 27, 14, 30)


def test_holiday_monday_skipped() -> None:
    fri_evening = utc(2027, 1, 15, 23, 0)  # MLK day is Mon 18 Jan 2027
    assert next_session_open(fri_evening) == utc(2027, 1, 19, 14, 30)
    assert next_session_close(fri_evening) == utc(2027, 1, 19, 21, 0)
    fri_sep = utc(2026, 9, 4, 22, 0)  # Labor Day Mon 7 Sep 2026
    assert next_session_open(fri_sep) == utc(2026, 9, 8, 13, 30)  # EDT


def test_weekend_goes_to_monday() -> None:
    sat = utc(2026, 11, 14, 12, 0)
    assert next_session_open(sat) == utc(2026, 11, 16, 14, 30)
    assert current_session_open(sat) is None


def test_dst_change_weeks() -> None:
    # US spring-forward Sun 8 Mar 2026: Fri open 14:30 UTC (EST), Mon open 13:30 UTC (EDT).
    fri_evening = utc(2026, 3, 6, 23, 0)
    assert next_session_open(fri_evening) == utc(2026, 3, 9, 13, 30)
    assert next_session_close(fri_evening) == utc(2026, 3, 9, 20, 0)
    # Fall-back Sun 1 Nov 2026: Fri close 20:00 UTC (EDT), Mon open 14:30 UTC (EST).
    fri_after = utc(2026, 10, 30, 21, 0)
    assert next_session_open(fri_after) == utc(2026, 11, 2, 14, 30)
    assert next_session_close(fri_after) == utc(2026, 11, 2, 21, 0)


def test_last_close_after_a_half_day_and_a_holiday() -> None:
    # Thanksgiving Thu 26/11/2026 is shut; Black Friday 27/11 closes at 13:00 ET = 18:00Z.
    friday_morning = utc(2026, 11, 27, 10, 0)
    assert last_session_close(friday_morning) == utc(2026, 11, 25, 21, 0)  # skips the holiday
    during = utc(2026, 11, 27, 16, 0)
    assert next_session_close(during) == utc(2026, 11, 27, 18, 0)  # the half-day close
    saturday = utc(2026, 11, 28, 12, 0)
    assert last_session_close(saturday) == utc(2026, 11, 27, 18, 0)
    assert next_session_open(saturday) == utc(2026, 11, 30, 14, 30)


def test_last_close_is_at_or_before_now() -> None:
    at_bell = utc(2026, 11, 17, 21, 0)
    assert last_session_close(at_bell) == at_bell
    assert last_session_close(utc(2026, 11, 17, 20, 59)) == utc(2026, 11, 16, 21, 0)
