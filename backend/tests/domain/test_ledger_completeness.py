"""Ledger completeness hints (v7 P7): golden cases plus properties."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain import ledger_completeness as lc

TODAY = date(2026, 11, 10)


def _buy(day: date, qty: str = "10") -> lc.LedgerEvent:
    return lc.LedgerEvent(date=day, kind="buy", quantity=Decimal(qty))


def test_missing_dividend_is_reported_with_shares_held() -> None:
    out = lc.find_missing_dividends([date(2026, 3, 10)], [_buy(date(2026, 1, 5))], today=TODAY)
    assert out == [lc.MissingDividend(ex_date=date(2026, 3, 10), shares_held=Decimal("10"))]


def test_dividend_row_inside_window_clears_the_hint() -> None:
    events = [
        _buy(date(2026, 1, 5)),
        lc.LedgerEvent(date=date(2026, 3, 25), kind="dividend_cash"),
    ]
    assert lc.find_missing_dividends([date(2026, 3, 10)], events, today=TODAY) == []


def test_reinvestment_counts_and_row_after_window_does_not() -> None:
    reinvest = lc.LedgerEvent(date=date(2026, 3, 12), kind="dividend_reinvest", quantity=Decimal(1))
    assert (
        lc.find_missing_dividends(
            [date(2026, 3, 10)], [_buy(date(2026, 1, 5)), reinvest], today=TODAY
        )
        == []
    )
    late = lc.LedgerEvent(date=date(2026, 6, 1), kind="dividend_cash")
    assert (
        len(
            lc.find_missing_dividends(
                [date(2026, 3, 10)], [_buy(date(2026, 1, 5)), late], today=TODAY
            )
        )
        == 1
    )


def test_buy_on_the_ex_date_does_not_earn_the_dividend() -> None:
    assert (
        lc.find_missing_dividends([date(2026, 3, 10)], [_buy(date(2026, 3, 10))], today=TODAY) == []
    )


def test_sold_out_before_ex_date_is_not_flagged() -> None:
    events = [
        _buy(date(2026, 1, 5)),
        lc.LedgerEvent(date=date(2026, 2, 1), kind="sell", quantity=Decimal("-10")),
    ]
    assert lc.find_missing_dividends([date(2026, 3, 10)], events, today=TODAY) == []


def test_recent_ex_date_is_not_judged_yet() -> None:
    assert (
        lc.find_missing_dividends(
            [TODAY - timedelta(days=10)], [_buy(date(2026, 1, 5))], today=TODAY
        )
        == []
    )


def test_money_market_is_judged_per_month() -> None:
    ex = [date(2026, 3, d) for d in (5, 20, 31)]
    events = [_buy(date(2026, 1, 5), "100")]
    out = lc.find_missing_money_market_distributions(ex, events, today=TODAY)
    assert [m.ex_date for m in out] == [date(2026, 3, 31)]
    paid = [*events, lc.LedgerEvent(date=date(2026, 4, 2), kind="interest")]
    assert lc.find_missing_money_market_distributions(ex, paid, today=TODAY) == []


def test_days_since() -> None:
    assert lc.days_since(None, TODAY) is None
    assert lc.days_since(date(2026, 11, 1), TODAY) == 9
    assert lc.days_since(date(2027, 1, 1), TODAY) == 0


@given(
    ex=st.lists(st.dates(min_value=date(2020, 1, 1), max_value=date(2026, 12, 31)), max_size=8),
    qty=st.decimals(min_value=Decimal("0.01"), max_value=Decimal(1000), places=2),
)
def test_never_flags_without_holdings_and_results_are_sorted(ex: list[date], qty: Decimal) -> None:
    assert lc.find_missing_dividends(ex, [], today=TODAY) == []
    out = lc.find_missing_dividends(ex, [_buy(date(2019, 1, 1), str(qty))], today=TODAY)
    assert [m.ex_date for m in out] == sorted({m.ex_date for m in out})
    assert all(m.shares_held == qty for m in out)
    assert all(m.ex_date + timedelta(days=lc.DEFAULT_WINDOW_DAYS) < TODAY for m in out)


@given(ex=st.dates(min_value=date(2020, 1, 1), max_value=date(2026, 6, 1)), lag=st.integers(0, 60))
def test_any_payout_within_the_window_clears(ex: date, lag: int) -> None:
    events = [
        _buy(date(2019, 1, 1)),
        lc.LedgerEvent(date=ex + timedelta(days=lag), kind="dividend_cash"),
    ]
    assert lc.find_missing_dividends([ex], events, today=TODAY) == []
