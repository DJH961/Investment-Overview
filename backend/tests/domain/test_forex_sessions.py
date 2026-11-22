"""Forex trading days (:func:`domain.market_hours.forex_sessions`)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import pairwise

from investment_dashboard.domain.market_hours import forex_sessions


def test_midweek_walks_back_over_the_weekend() -> None:
    out = forex_sessions(datetime(2026, 11, 18, 12, 0, tzinfo=UTC), 5)  # Wednesday
    assert len(out) == 5
    assert out[-1][0] == datetime(2026, 11, 17, 22, 0, tzinfo=UTC)  # Tue 17:00 ET (EST)
    assert out[-1][1] == datetime(2026, 11, 18, 22, 0, tzinfo=UTC)
    assert out[0][0] == datetime(
        2026, 11, 11, 22, 0, tzinfo=UTC
    )  # Thursday's day opens Wednesday evening
    for prev, nxt in pairwise(out):
        assert prev[1] >= nxt[0] - timedelta(days=2, hours=1)


def test_weekend_shows_friday_and_sunday_evening_opens_monday() -> None:
    sat = forex_sessions(datetime(2026, 11, 21, 12, 0, tzinfo=UTC), 1)
    assert sat == [
        (datetime(2026, 11, 19, 22, 0, tzinfo=UTC), datetime(2026, 11, 20, 22, 0, tzinfo=UTC))
    ]
    sun_eve = forex_sessions(datetime(2026, 11, 22, 23, 0, tzinfo=UTC), 1)
    assert sun_eve[0][0] == datetime(2026, 11, 22, 22, 0, tzinfo=UTC)  # Monday's day has opened
