# ruff: noqa: PT018
"""Plan suggestions from ledger history."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.recurrence_suggest import Observation, suggest_cadence

D = Decimal


def _obs(days: list[date], amount: str = "100") -> list[Observation]:
    return [Observation(d, D(amount)) for d in days]


def test_weekly_buys_on_mondays() -> None:
    mondays = [date(2026, 11, 2) + timedelta(weeks=i) for i in range(4)]
    s = suggest_cadence(_obs(mondays, "50"))
    assert s is not None
    assert (s.unit, s.every, s.anchor, s.amount, s.occurrences) == ("weeks", 1, 0, D("50"), 4)


def test_monthly_deposit_on_the_fifth() -> None:
    days = [date(2026, 8, 5), date(2026, 9, 5), date(2026, 10, 5), date(2026, 11, 5)]
    s = suggest_cadence(_obs(days, "2500"))
    assert s is not None
    assert (s.unit, s.every, s.anchor, s.amount) == ("months", 1, 5, D("2500"))


def test_monthly_on_a_drifting_weekend_day_still_picks_the_commonest_day() -> None:
    days = [date(2026, 8, 3), date(2026, 9, 1), date(2026, 10, 1), date(2026, 11, 1)]
    s = suggest_cadence(_obs(days))
    assert s is not None and s.anchor == 1


def test_every_two_weeks_median_amount_ignores_one_outlier() -> None:
    days = [date(2026, 10, 5) + timedelta(weeks=2 * i) for i in range(4)]
    obs = [Observation(d, D(a)) for d, a in zip(days, ("100", "100", "900", "100"), strict=True)]
    s = suggest_cadence(obs)
    assert s is not None and (s.unit, s.every, s.amount) == ("weeks", 2, D("100"))


def test_too_few_or_irregular_gives_nothing() -> None:
    assert suggest_cadence(_obs([date(2026, 1, 1), date(2026, 1, 8)])) is None
    irregular = [date(2026, 1, 1), date(2026, 1, 20), date(2026, 3, 2), date(2026, 3, 4)]
    assert suggest_cadence(_obs(irregular)) is None


@given(st.dates(min_value=date(2022, 1, 1), max_value=date(2030, 1, 1)), st.integers(3, 8))
def test_weekly_series_is_always_recognised(start: date, n: int) -> None:
    days = [start + timedelta(weeks=i) for i in range(n)]
    s = suggest_cadence(_obs(days))
    assert s is not None
    assert (s.unit, s.every, s.anchor) == ("weeks", 1, start.weekday())
