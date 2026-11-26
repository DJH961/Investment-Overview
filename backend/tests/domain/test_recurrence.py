"""Recurring plans: due dates (golden + property tests) and estimate pricing."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from itertools import pairwise

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import recurrence as rec
from investment_dashboard.domain.recurrence import Cadence

D = Decimal


def _dates(c: Cadence, start: date, lo: date, hi: date, end: date | None = None) -> list[date]:
    return rec.due_dates(c, start=start, end=end, window_from=lo, window_to=hi)


# ---------------------------------------------------------------- golden values


def test_month_end_anchor_clamps_without_drifting() -> None:
    got = _dates(Cadence("months", 1, 31), date(2026, 1, 31), date(2026, 1, 1), date(2026, 5, 31))
    assert got == [
        date(2026, 1, 31),
        date(2026, 2, 28),
        date(2026, 3, 31),
        date(2026, 4, 30),
        date(2026, 5, 31),
    ]


def test_leap_february() -> None:
    got = _dates(Cadence("months", 12, 29), date(2027, 2, 1), date(2027, 1, 1), date(2032, 12, 31))
    assert got == [
        date(2027, 2, 28),
        date(2028, 2, 29),
        date(2029, 2, 28),
        date(2030, 2, 28),
        date(2031, 2, 28),
        date(2032, 2, 29),
    ]


def test_month_anchor_after_start_day_starts_next_month() -> None:
    got = _dates(Cadence("months", 1, 15), date(2026, 1, 20), date(2026, 1, 1), date(2026, 3, 31))
    assert got == [date(2026, 2, 15), date(2026, 3, 15)]


def test_month_default_anchor_is_start_day() -> None:
    got = _dates(Cadence("months", 3), date(2026, 1, 10), date(2026, 1, 1), date(2026, 12, 31))
    assert got == [date(2026, 1, 10), date(2026, 4, 10), date(2026, 7, 10), date(2026, 10, 10)]


def test_weeks_anchor_weekday() -> None:
    # 2026-11-18 is a Wednesday; first Monday on or after is 2026-11-23.
    got = _dates(Cadence("weeks", 2, 0), date(2026, 11, 18), date(2026, 11, 1), date(2026, 12, 31))
    assert got == [date(2026, 11, 23), date(2026, 12, 7), date(2026, 12, 21)]


def test_days_every_ten() -> None:
    got = _dates(Cadence("days", 10), date(2026, 1, 1), date(2026, 1, 1), date(2026, 1, 31))
    assert got == [date(2026, 1, 1), date(2026, 1, 11), date(2026, 1, 21), date(2026, 1, 31)]


def test_end_date_inclusive_and_next_due() -> None:
    c = Cadence("months", 1, 5)
    got = _dates(c, date(2026, 1, 1), date(2026, 1, 1), date(2026, 12, 31), end=date(2026, 3, 5))
    assert got == [date(2026, 1, 5), date(2026, 2, 5), date(2026, 3, 5)]
    assert (
        rec.next_due(c, start=date(2026, 1, 1), end=date(2026, 3, 5), after=date(2026, 3, 5))
        is None
    )
    assert rec.next_due(c, start=date(2026, 1, 1), end=None, after=date(2026, 3, 5)) == date(
        2026, 4, 5
    )


def test_roll_to_next_session() -> None:
    assert rec.roll_to_session(date(2026, 11, 28)) == date(2026, 11, 30)  # Saturday
    assert rec.roll_to_session(date(2026, 11, 26)) == date(2026, 11, 27)  # Thanksgiving
    assert rec.roll_to_session(date(2026, 11, 25)) == date(2026, 11, 25)  # Wednesday
    assert rec.roll_to_session(date(2026, 12, 25)) == date(2026, 12, 28)  # Christmas Friday


def test_buy_figures() -> None:
    assert rec.buy_figures(close=D("50"), amount=D("20"), shares=None) == (D("0.4"), D("20"))
    assert rec.buy_figures(close=D("50"), amount=None, shares=D("2")) == (D("2"), D("100"))
    with pytest.raises(ValueError, match=r"."):
        rec.buy_figures(close=D("0"), amount=D("1"), shares=None)
    with pytest.raises(ValueError, match=r"."):
        rec.buy_figures(close=D("1"), amount=None, shares=None)


def test_estimated_conversion_pushes_ecb_by_offset() -> None:
    assert rec.estimated_conversion(
        eur_sent=D("500"), ecb_rate=D("1.20"), avg_off_pct=D("0.005")
    ) == (D("1.206"), D("603"))
    # No history: plain ECB.
    assert rec.estimated_conversion(eur_sent=D("500"), ecb_rate=D("1.20"), avg_off_pct=None) == (
        D("1.20"),
        D("600"),
    )


def test_estimated_conversion_eur_golden() -> None:
    assert rec.estimated_conversion_eur(
        usd_received=D("603"), ecb_rate=D("1.20"), avg_off_pct=D("0.005")
    ) == (D("1.206"), D("500"))
    assert rec.estimated_conversion_eur(
        usd_received=D("600"), ecb_rate=D("1.20"), avg_off_pct=None
    ) == (D("1.20"), D("500"))
    with pytest.raises(ValueError, match=r"."):
        rec.estimated_conversion_eur(usd_received=D("0"), ecb_rate=D("1.20"), avg_off_pct=None)
    with pytest.raises(ValueError, match=r"."):
        rec.estimated_conversion_eur(usd_received=D("100"), ecb_rate=D("0"), avg_off_pct=None)


@settings(max_examples=100, deadline=None)
@given(
    st.decimals(min_value=1, max_value=100000, places=2),
    st.decimals(min_value="0.5", max_value="2.5", places=4),
    st.none() | st.decimals(min_value="-0.05", max_value="0.05", places=4),
)
def test_estimated_conversion_eur_round_trips_with_estimated_conversion(
    eur_sent: Decimal, ecb_rate: Decimal, avg_off_pct: Decimal | None
) -> None:
    rate, usd_received = rec.estimated_conversion(
        eur_sent=eur_sent, ecb_rate=ecb_rate, avg_off_pct=avg_off_pct
    )
    rate_back, eur_back = rec.estimated_conversion_eur(
        usd_received=usd_received, ecb_rate=ecb_rate, avg_off_pct=avg_off_pct
    )
    assert rate_back == rate
    assert abs(eur_back - eur_sent) < D("0.0000000001")


def test_cadence_validation() -> None:
    with pytest.raises(ValueError, match=r"."):
        Cadence("fortnights", 1)
    with pytest.raises(ValueError, match=r"."):
        Cadence("days", 0)
    with pytest.raises(ValueError, match=r"."):
        Cadence("weeks", 1, 7)
    with pytest.raises(ValueError, match=r"."):
        Cadence("months", 1, 32)


# ------------------------------------------------------------------ properties

_dates_st = st.dates(min_value=date(2020, 1, 1), max_value=date(2032, 12, 31))
_cadence_st = st.one_of(
    st.builds(Cadence, st.just("days"), st.integers(1, 40)),
    st.builds(Cadence, st.just("weeks"), st.integers(1, 6), st.none() | st.integers(0, 6)),
    st.builds(Cadence, st.just("months"), st.integers(1, 14), st.none() | st.integers(1, 31)),
)


@settings(max_examples=150, deadline=None)
@given(
    _cadence_st,
    _dates_st,
    st.none() | _dates_st,
    _dates_st,
    st.integers(0, 900),
)
def test_due_dates_invariants(
    c: Cadence, start: date, end: date | None, lo: date, span: int
) -> None:
    hi = lo + timedelta(days=span)
    got = _dates(c, start, lo, hi, end)
    assert got == sorted(set(got))  # ascending, no duplicates
    for d in got:
        assert max(lo, start) <= d <= (hi if end is None else min(hi, end))
    if c.unit == "days":
        assert all((b - a).days == c.every for a, b in pairwise(got))
    if c.unit == "weeks":
        assert all((b - a).days == 7 * c.every for a, b in pairwise(got))
        assert all(d.weekday() == got[0].weekday() for d in got)
    if c.unit == "months":
        anchor = start.day if c.anchor is None else c.anchor
        for d in got:
            nxt = date(d.year + d.month // 12, d.month % 12 + 1, 1)
            last = (nxt - timedelta(days=1)).day
            assert d.day == min(anchor, last)
        months = [d.year * 12 + d.month for d in got]
        assert all(b - a == c.every for a, b in pairwise(months))


@settings(max_examples=150, deadline=None)
@given(
    _cadence_st,
    _dates_st,
    st.none() | _dates_st,
    _dates_st,
    st.integers(1, 400),
    st.integers(0, 400),
)
def test_catching_up_equals_union_of_short_steps(
    c: Cadence, start: date, end: date | None, lo: date, span: int, cut: int
) -> None:
    hi = lo + timedelta(days=span)
    mid = lo + timedelta(days=min(cut, span))
    whole = _dates(c, start, lo, hi, end)
    parts = _dates(c, start, lo, mid, end) + _dates(c, start, mid + timedelta(days=1), hi, end)
    assert whole == parts


@settings(max_examples=100, deadline=None)
@given(_cadence_st, _dates_st, st.none() | _dates_st)
def test_next_due_agrees_with_due_dates(c: Cadence, start: date, end: date | None) -> None:
    first = rec.next_due(c, start=start, end=end, after=start - timedelta(days=1))
    listed = _dates(c, start, start, start + timedelta(days=500), end)
    if listed:
        assert first == listed[0]
    elif first is not None:
        assert first > start + timedelta(days=500) or (end is not None and first <= end)


def test_per_run_amount_golden() -> None:
    per = rec.per_run_amount
    # A monthly 2,750 deposit, spent weekly: 2,750 x 12 / 52.
    assert per(D("2750"), paid=("months", 1), spent=("weeks", 1)) == D("2750") * 12 / 52
    assert round(per(D("2750"), paid=("months", 1), spent=("weeks", 1)), 2) == D("634.62")
    # Spent monthly it is used up in one run; every 2 weeks, 2,750 x 12 / 26.
    assert per(D("2750"), paid=("months", 1), spent=("months", 1)) == D("2750")
    assert round(per(D("2750"), paid=("months", 1), spent=("weeks", 2)), 2) == D("1269.23")
    # Every 2 months paid, monthly spent: half each time.
    assert per(D("600"), paid=("months", 2), spent=("months", 1)) == D("300")


@given(
    st.sampled_from(["days", "weeks", "months"]),
    st.integers(1, 12),
    st.decimals(1, 10000, places=2),
)
def test_per_run_amount_uses_up_the_deposit_over_a_year(
    unit: str, every: int, total: Decimal
) -> None:
    run = rec.per_run_amount(total, paid=("months", 1), spent=(unit, every))
    # A year of buys uses up a year of deposits (exact in rational arithmetic; tiny Decimal rounding).
    assert abs(run * rec.runs_per_year(unit, every) - total * 12) < D("0.0001")
    assert rec.per_run_amount(total, paid=(unit, every), spent=(unit, every)) == total


def test_independent_cadences_run_on_their_own_schedules() -> None:
    lo, hi = date(2026, 3, 1), date(2026, 3, 31)
    conversion = _dates(Cadence("months", 1, 2), date(2026, 1, 1), lo, hi)
    deposit = _dates(Cadence("weeks", 2, 0), date(2026, 3, 2), lo, hi)  # Mondays, fortnightly
    buy = _dates(Cadence("weeks", 1, 4), date(2026, 3, 2), lo, hi)  # Fridays, weekly
    assert conversion == [date(2026, 3, 2)]
    assert deposit == [date(2026, 3, 2), date(2026, 3, 16), date(2026, 3, 30)]
    assert buy == [date(2026, 3, 6), date(2026, 3, 13), date(2026, 3, 20), date(2026, 3, 27)]
    # Totals may conflict: $300 a fortnight deposited, $400 a week bought draws cash down.
    deposited = D("300") * rec.runs_per_year("weeks", 2)
    bought = D("400") * rec.runs_per_year("weeks", 1)
    assert bought > deposited
