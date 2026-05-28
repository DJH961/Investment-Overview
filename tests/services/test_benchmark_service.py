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
