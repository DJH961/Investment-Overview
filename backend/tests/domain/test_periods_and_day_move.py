"""Property tests for :mod:`domain.periods` and :mod:`domain.day_move`."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain import day_move, periods

money = st.decimals(min_value=Decimal("0.01"), max_value=Decimal("1e7"), places=2)
flow = st.decimals(min_value=Decimal("-1e6"), max_value=Decimal("1e6"), places=2)
days = st.dates(min_value=date(2020, 1, 1), max_value=date(2030, 12, 31))


@given(days)
def test_opening_is_the_day_before_and_first_day_flows_count(as_of: date) -> None:
    for w in (periods.month_to_date(as_of), periods.year_to_date(as_of)):
        assert w.opening_date == w.start - timedelta(days=1)
        assert w.counts_flow(w.start)
        assert not w.counts_flow(w.opening_date)
        assert w.counts_flow(as_of)


@given(money, flow)
def test_flat_market_growth_is_zero(opening: Decimal, f: Decimal) -> None:
    """Flat market: the closing value is exactly opening + flows, so growth is 0."""
    closing = opening + f
    assert periods.move_after_flows(opening, closing, f) == 0
    g = periods.growth_after_flows(opening, closing, f)
    assert g is None or g == 0


@given(money, money, flow)
def test_growth_times_base_is_the_move(opening: Decimal, closing: Decimal, f: Decimal) -> None:
    g = periods.growth_after_flows(opening, closing, f)
    if opening + f > 0:
        assert g is not None
        assert abs(g * (opening + f) - periods.move_after_flows(opening, closing, f)) < Decimal(
            "1e-12"
        )
    else:
        assert g is None


@given(days, st.integers(1, 5))
def test_session_window_holds_the_flows_after_the_previous_close(prev: date, gap: int) -> None:
    last = prev + timedelta(days=gap)
    w = periods.session_window(prev, last)
    assert w.opening_date == prev
    assert not w.counts_flow(prev)
    assert w.counts_flow(last)


rate = st.decimals(min_value=Decimal("0.5"), max_value=Decimal("2"), places=4)
price = st.decimals(min_value=Decimal("1"), max_value=Decimal("1000"), places=2)
shares = st.decimals(min_value=Decimal("0.001"), max_value=Decimal("10000"), places=3)


@given(shares, price, price, rate, rate)
def test_usd_holding_eur_pct_is_value_ratio_at_own_rates(
    qty: Decimal, px_now: Decimal, px_prev: Decimal, r_now: Decimal, r_prev: Decimal
) -> None:
    """EUR % = (px_now / r_now) / (px_prev / r_prev) - 1: FX-aware, never the USD % reused."""
    legs = day_move.DayLegs(px_now, date(2026, 1, 2), px_prev, date(2026, 1, 1), date(2026, 1, 2))
    m = day_move.holding_day_move(
        shares=qty, native_currency="USD", legs=legs, rate_last=r_now, rate_prev=r_prev
    )
    assert m.pct_usd is not None
    assert m.pct_eur is not None
    assert abs(m.pct_usd - (px_now / px_prev - 1)) < Decimal("1e-20")
    expected_eur = (px_now / r_now) / (px_prev / r_prev) - 1
    assert abs(m.pct_eur - expected_eur) < Decimal("1e-20")
    assert m.move_usd == qty * (px_now - px_prev)


@given(st.lists(st.tuples(money, flow), min_size=1, max_size=8))
def test_group_pct_is_summed_move_over_summed_base(members: list[tuple[Decimal, Decimal]]) -> None:
    pairs = [(m, b) for b, m in members]
    base = sum((b for _, b in pairs), start=Decimal(0))
    pct = day_move.group_day_pct(pairs)
    if base > 0:
        assert pct == sum((m for m, _ in pairs), start=Decimal(0)) / base
    else:
        assert pct is None
