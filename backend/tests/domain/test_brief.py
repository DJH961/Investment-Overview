"""Daily Brief window: which NYSE sessions passed since the previous visit."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from investment_dashboard.domain.brief import brief_window, session_boundaries

ET = ZoneInfo("America/New_York")


def et(y: int, m: int, d: int, hh: int = 0, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=ET).astimezone(UTC)


# 2026: Mon 16 Nov, Fri 20, Sat 21, Sun 22, Mon 23, Wed 25, Thu 26 (Thanksgiving),
# Fri 27 (half-day, close 13:00 ET = 18:00 UTC). EST all through.
CASES = [
    pytest.param(
        et(2026, 11, 16, 16, 30), et(2026, 11, 16, 20, 0), None, 0, id="two-visits-evening"
    ),
    pytest.param(et(2026, 11, 16, 8, 0), et(2026, 11, 16, 11, 0), "session", 1, id="before-open"),
    pytest.param(
        et(2026, 11, 16, 11, 0), et(2026, 11, 16, 17, 0), "session", 1, id="midday-to-after-close"
    ),
    pytest.param(
        et(2026, 11, 20, 17, 0), et(2026, 11, 23, 10, 0), "session", 1, id="fri-evening-to-mon-open"
    ),
    pytest.param(
        et(2026, 11, 20, 17, 0), et(2026, 11, 21, 12, 0), None, 0, id="fri-eve-to-saturday"
    ),
    pytest.param(
        et(2026, 11, 20, 15, 0), et(2026, 11, 22, 18, 0), "session", 1, id="fri-3pm-to-sun-18"
    ),
    pytest.param(
        et(2026, 11, 21, 12, 0), et(2026, 11, 22, 18, 0), "fx_reopen", 0, id="sat-to-sun-18"
    ),
    pytest.param(et(2026, 11, 21, 12, 0), et(2026, 11, 22, 16, 0), None, 0, id="sat-to-sun-16"),
    pytest.param(et(2026, 11, 25, 18, 0), et(2026, 11, 26, 20, 0), None, 0, id="thanksgiving"),
    pytest.param(
        et(2026, 11, 27, 9, 0), et(2026, 11, 27, 13, 30), "session", 1, id="half-day-close-inside"
    ),
    pytest.param(
        et(2026, 11, 27, 13, 30), et(2026, 11, 27, 16, 30), None, 0, id="half-day-close-outside"
    ),
    pytest.param(
        et(2026, 11, 16, 17, 0), et(2026, 11, 23, 17, 0), "sessions", 5, id="mon-to-next-mon"
    ),
    pytest.param(et(2026, 11, 16, 8, 0), et(2026, 11, 16, 8, 0), None, 0, id="now-equals-seen"),
    pytest.param(et(2026, 11, 16, 12, 0), et(2026, 11, 16, 8, 0), None, 0, id="now-before-seen"),
]


@pytest.mark.parametrize(("previous_seen", "now", "kind", "passed"), CASES)
def test_window_table(
    previous_seen: datetime, now: datetime, kind: str | None, passed: int
) -> None:
    window = brief_window(previous_seen, now)
    if kind is None:
        assert window is None
    else:
        assert window is not None
        assert window.kind == kind
        assert window.sessions_passed == passed


def test_first_login_has_no_brief() -> None:
    assert brief_window(None, et(2026, 11, 16, 12, 0)) is None


def test_half_day_close_is_13_et() -> None:
    bounds = session_boundaries(et(2026, 11, 27, 8, 0), et(2026, 11, 27, 20, 0))
    assert [(b.kind, b.at) for b in bounds] == [
        ("open", et(2026, 11, 27, 9, 30)),
        ("close", datetime(2026, 11, 27, 18, 0, tzinfo=UTC)),
    ]


def test_naive_datetimes_are_utc() -> None:
    window = brief_window(datetime(2026, 11, 16, 12, 0), datetime(2026, 11, 16, 22, 0))
    assert window is not None
    assert window.kind == "session"
    assert window.sessions == (date(2026, 11, 16),)


def test_ancient_visit_stays_cheap() -> None:
    window = brief_window(datetime(1990, 1, 1, tzinfo=UTC), et(2026, 11, 16, 12, 0))
    assert window is not None
    assert window.kind == "sessions"


@settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    previous_seen=st.datetimes(min_value=datetime(2024, 1, 1), max_value=datetime(2028, 1, 1)),
    gap=st.integers(min_value=0, max_value=60 * 24 * 40),
)
def test_boundaries_inside_window_and_sorted(previous_seen: datetime, gap: int) -> None:
    previous_seen = previous_seen.replace(tzinfo=UTC)
    now = previous_seen + timedelta(minutes=gap)
    for b in session_boundaries(previous_seen, now):
        assert previous_seen < b.at <= now
    bounds = session_boundaries(previous_seen, now)
    assert [b.at for b in bounds] == sorted(b.at for b in bounds)
