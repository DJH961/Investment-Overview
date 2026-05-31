"""Tests for ``investment_dashboard.services.benchmark_service``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from investment_dashboard.repositories import instruments_repo
from investment_dashboard.services import benchmark_service as svc


def test_default_symbol_is_vt(session) -> None:
    assert svc.get_symbol(session) == "VT"


def test_set_symbol_uppercases(session) -> None:
    svc.set_symbol(session, "urth")
    assert svc.get_symbol(session) == "URTH"


def test_set_symbol_rejects_empty(session) -> None:
    with pytest.raises(ValueError, match="non-empty"):
        svc.set_symbol(session, "   ")


def _fake_fetcher(closes_by_symbol: dict[str, dict[date, Decimal]]):
    def _fetch(symbols, start, end):
        return {s: closes_by_symbol.get(s, {}) for s in symbols}

    return _fetch


def test_refresh_creates_instrument_and_persists_closes(session) -> None:
    fetcher = _fake_fetcher(
        {
            "VT": {
                date(2026, 1, 2): Decimal("100"),
                date(2026, 1, 3): Decimal("101"),
                date(2026, 1, 6): Decimal("103"),
            }
        }
    )
    n = svc.refresh_history(
        session,
        start=date(2026, 1, 2),
        end=date(2026, 1, 7),
        fetcher=fetcher,
    )
    assert n >= 3
    instr = instruments_repo.get_by_symbol(session, "VT")
    assert instr is not None
    assert instr.asset_class == "etf"

    series = svc.get_series(session, start=date(2026, 1, 2), end=date(2026, 1, 6))
    assert series.symbol == "VT"
    assert series.closes[date(2026, 1, 3)] == Decimal("101")


def test_refresh_empty_returns_zero(session) -> None:
    n = svc.refresh_history(
        session,
        start=date(2026, 1, 2),
        end=date(2026, 1, 7),
        fetcher=_fake_fetcher({}),
    )
    assert n == 0


def test_get_series_with_no_instrument_is_empty(session) -> None:
    series = svc.get_series(session, start=date(2026, 1, 1), end=date(2026, 1, 31))
    assert series.closes == {}


def test_daily_returns_computes_simple_returns(session) -> None:
    fetcher = _fake_fetcher(
        {
            "VT": {
                date(2026, 1, 2): Decimal("100"),
                date(2026, 1, 3): Decimal("110"),
                date(2026, 1, 6): Decimal("99"),
            }
        }
    )
    svc.refresh_history(session, start=date(2026, 1, 2), end=date(2026, 1, 7), fetcher=fetcher)
    series = svc.get_series(session, start=date(2026, 1, 2), end=date(2026, 1, 7))
    rets = series.daily_returns()
    assert rets[0] == Decimal("0.1")
    assert rets[1] == Decimal("-0.1")


def test_changing_symbol_uses_new_instrument(session) -> None:
    fetcher = _fake_fetcher(
        {
            "VT": {date(2026, 1, 2): Decimal("100")},
            "URTH": {date(2026, 1, 2): Decimal("80")},
        }
    )
    svc.refresh_history(session, start=date(2026, 1, 2), end=date(2026, 1, 3), fetcher=fetcher)
    svc.set_symbol(session, "URTH")
    svc.refresh_history(session, start=date(2026, 1, 2), end=date(2026, 1, 3), fetcher=fetcher)
    series = svc.get_series(session, start=date(2026, 1, 2), end=date(2026, 1, 3))
    assert series.symbol == "URTH"
    assert series.closes[date(2026, 1, 2)] == Decimal("80")


def test_simulate_benchmark_xirr_from_contributions(session) -> None:
    """A single contribution routed into the benchmark reproduces the index's
    own buy-and-hold return as the simulated XIRR's compounded growth."""
    from investment_dashboard.domain.returns import total_growth_pct_compounded, years_between
    from investment_dashboard.models import Transaction
    from investment_dashboard.models.transaction import TransactionSource
    from investment_dashboard.repositories import accounts_repo, fx_repo, prices_repo

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Cash",
        native_currency="EUR",
        account_type="brokerage",
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            net_eur=Decimal("1000"),
            source=TransactionSource.MANUAL,
        )
    )
    vt = instruments_repo.get_or_create(session, symbol="VT", asset_class="etf")
    prices_repo.upsert_closes(
        session,
        vt.id,
        {date(2024, 1, 5): Decimal("100.00"), date.today(): Decimal("110.00")},
    )
    fx_repo.upsert_rates(
        session, {date(2024, 1, 5): Decimal("1.00"), date.today(): Decimal("1.00")}
    )
    session.flush()

    bench_xirr = svc.simulate_benchmark_xirr(session, as_of=date.today())
    assert bench_xirr is not None
    years = years_between(date(2024, 1, 5), date.today())
    growth = total_growth_pct_compounded(bench_xirr, years)
    assert growth is not None
    assert abs(growth - Decimal("0.10")) < Decimal("0.0001")


def test_simulate_benchmark_xirr_none_without_contributions(session) -> None:
    """With no external contributions there is nothing to route into the
    benchmark, so the simulation declines to produce a figure."""
    assert svc.simulate_benchmark_xirr(session, as_of=date.today()) is None
