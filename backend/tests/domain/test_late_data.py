"""Late NAVs and overnight currency: estimate, linear correction, day split (pure maths)."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain import index_twins
from investment_dashboard.domain.late_data import (
    Holding,
    corrected_value,
    estimate_value,
    fund_value_at,
    session_fraction,
    split_day_change,
    typical_daily_gap,
    value_at_rate,
)

OPEN = datetime(2026, 11, 4, 14, 30)  # 09:30 New York
CLOSE = datetime(2026, 11, 4, 21, 0)  # 16:00 New York

money = st.decimals(min_value="1", max_value="1000000", places=4, allow_nan=False)
price = st.decimals(min_value="1", max_value="5000", places=4, allow_nan=False)
fx = st.decimals(min_value="0.5", max_value="2", places=6, allow_nan=False)
minutes = st.integers(min_value=0, max_value=390)


# -- golden values (checked by hand) ------------------------------------------------


def test_estimate_golden() -> None:
    # Fund closed at NAV 100; its twin closed at 500 and trades at 505 (+1 %).
    assert estimate_value(Decimal(100), Decimal(505), Decimal(500)) == Decimal("101")
    # No twin price: flat at the previous NAV.
    assert estimate_value(Decimal(100), None, Decimal(500)) == Decimal(100)
    assert estimate_value(Decimal(100), Decimal(505), None) == Decimal(100)


def test_correction_golden() -> None:
    # Twin closed +1 % (estimate 101) but the official NAV is 101.50.
    half = OPEN + (CLOSE - OPEN) / 2
    assert session_fraction(half, OPEN, CLOSE) == Decimal("0.5")
    # Mid-session the twin was +0.6 % -> estimate 100.60, plus half of the +0.50 gap.
    value = fund_value_at(
        prev_value=Decimal(100),
        official_value=Decimal("101.50"),
        twin_at=Decimal(503),
        twin_close=Decimal(505),
        twin_prev_close=Decimal(500),
        fraction=Decimal("0.5"),
    )
    assert value == Decimal("100.85")
    # No twin: a straight line from 100 to the official 101.50.
    flat_mid = fund_value_at(
        prev_value=Decimal(100),
        official_value=Decimal("101.50"),
        twin_at=None,
        twin_close=None,
        twin_prev_close=None,
        fraction=Decimal("0.5"),
    )
    assert flat_mid == Decimal("100.75")


def test_split_golden() -> None:
    # Previous close €10,000, last session's close €10,150, now €10,080 (EUR firmed).
    split = split_day_change(Decimal(10000), Decimal(10150), Decimal(10080))
    assert split.move == Decimal(150)
    assert split.overnight == Decimal(-70)
    assert split.pct == Decimal("0.015")


def test_value_at_rate_golden() -> None:
    book = [Holding("USD", Decimal(1100)), Holding("EUR", Decimal(500))]
    eur, usd = value_at_rate(book, Decimal("1.10"))
    assert eur == Decimal(1500)
    assert usd == Decimal("1650.00")
    with pytest.raises(ValueError, match="positive"):
        value_at_rate(book, Decimal(0))


# -- properties ---------------------------------------------------------------------


@given(prev=price, official=price, twin_prev=price, twin_close=price, twin_mid=price)
def test_line_starts_at_prev_close_and_ends_at_official(
    prev: Decimal, official: Decimal, twin_prev: Decimal, twin_close: Decimal, twin_mid: Decimal
) -> None:
    def at(fraction: Decimal, twin: Decimal | None) -> Decimal:
        return fund_value_at(
            prev_value=prev,
            official_value=official,
            twin_at=twin,
            twin_close=twin_close,
            twin_prev_close=twin_prev,
            fraction=fraction,
        )

    # At the open the twin has not moved yet: the line starts at the previous close.
    assert at(Decimal(0), twin_prev) == prev
    # At the close it is exactly the official NAV: no spike, no gap.
    assert at(Decimal(1), twin_close) == official


@given(prev=price, official=price, a=minutes, b=minutes)
def test_flat_fund_blend_is_monotone(prev: Decimal, official: Decimal, a: int, b: int) -> None:
    """Without a twin the corrected line moves steadily from prev to official."""
    lo, hi = sorted((a, b))

    def at(m: int) -> Decimal:
        fraction = session_fraction(OPEN + timedelta(minutes=m), OPEN, CLOSE)
        return fund_value_at(
            prev_value=prev,
            official_value=official,
            twin_at=None,
            twin_close=None,
            twin_prev_close=None,
            fraction=fraction,
        )

    if official >= prev:
        assert at(lo) <= at(hi)
    else:
        assert at(lo) >= at(hi)
    assert min(prev, official) <= at(lo) <= max(prev, official)


@given(m=st.integers(min_value=-60, max_value=500))
def test_fraction_is_clamped(m: int) -> None:
    f = session_fraction(OPEN + timedelta(minutes=m), OPEN, CLOSE)
    assert Decimal(0) <= f <= Decimal(1)


@given(est=money, est_close=money, official=money)
def test_correction_endpoints(est: Decimal, est_close: Decimal, official: Decimal) -> None:
    assert corrected_value(est, est_close, official, Decimal(0)) == est
    assert corrected_value(est_close, est_close, official, Decimal(1)) == official


@given(
    usd_prev=money,
    usd_last=money,
    eur_prev=money,
    eur_last=money,
    fx_prev=fx,
    fx_close=fx,
    fx_now=fx,
)
def test_split_sums_to_total_change_in_each_currency(
    usd_prev: Decimal,
    usd_last: Decimal,
    eur_prev: Decimal,
    eur_last: Decimal,
    fx_prev: Decimal,
    fx_close: Decimal,
    fx_now: Decimal,
) -> None:
    """Each mark at its own rate; move + overnight == total change, EUR and USD alike."""
    prev = value_at_rate([Holding("USD", usd_prev), Holding("EUR", eur_prev)], fx_prev)
    last = value_at_rate([Holding("USD", usd_last), Holding("EUR", eur_last)], fx_close)
    # Overnight: same holdings and official prices, only the rate moved.
    now = value_at_rate([Holding("USD", usd_last), Holding("EUR", eur_last)], fx_now)
    for i in (0, 1):
        split = split_day_change(prev[i], last[i], now[i])
        # Exact up to Decimal's 28-digit context.
        assert abs(split.move + split.overnight - (now[i] - prev[i])) < Decimal("1e-18")
    # USD holdings are FX-free in USD: the USD overnight effect comes only from EUR ones.
    usd_split = split_day_change(prev[1], last[1], now[1])
    assert abs(usd_split.overnight - eur_last * (fx_now - fx_close)) < Decimal("1e-18")


def test_typical_daily_gap() -> None:
    start = date(2026, 1, 1)
    fund = {start + timedelta(days=i): Decimal(100) + i for i in range(25)}
    assert typical_daily_gap(fund, fund) == Decimal(0)
    assert typical_daily_gap(fund, {}) is None
    short = dict(list(fund.items())[:5])
    assert typical_daily_gap(short, short) is None


# -- twin list ----------------------------------------------------------------------


def test_twin_list_tiers() -> None:
    same = index_twins.suggest_twin("fxaix")
    assert same is not None
    assert (same.etf, same.tier) == ("VOO", "same_index")
    assert index_twins.suggest_twin("VFIAX").etf == "VOO"  # type: ignore[union-attr]
    close = {s.fund: s for s in index_twins.all_suggestions() if s.tier == "close"}
    assert set(close) == {"FSKAX", "FZROX", "FNILX"}
    assert (close["FSKAX"].etf, close["FSKAX"].typical_daily_gap) == ("VTI", "0.00019")
    for fund in ("FZILX", "FSELX", "VOO", None, ""):
        assert index_twins.suggest_twin(fund) is None
    funds = [s.fund for s in index_twins.all_suggestions()]
    assert len(funds) == len(set(funds))  # one suggestion per fund
