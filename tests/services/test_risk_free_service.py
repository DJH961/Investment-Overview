"""Tests for ``investment_dashboard.services.risk_free_service``."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from investment_dashboard.adapters.yfinance_client import PriceRecord
from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import risk_free_service as svc


def _make_fetcher(value: Decimal | None):
    def _fetch(symbol: str):
        if value is None:
            return None
        return PriceRecord(symbol=symbol, date=datetime.now().date(), close=value)

    return _fetch


def test_default_symbol_when_unset(session) -> None:
    assert svc.get_symbol(session) == "^IRX"


def test_stored_symbol_is_respected(session) -> None:
    """A persisted symbol is returned verbatim (no rewriting).

    ``^IRX`` is the default again now that ``fetch_latest_close`` retries
    empty bulk-download frames via ``Ticker.history``, so a stored value
    is honoured as-is rather than being bumped to another ticker.
    """
    app_config_repo.set_value(session, svc.KEY_SYMBOL, "^TNX")
    assert svc.get_symbol(session) == "^TNX"
    assert app_config_repo.get(session, svc.KEY_SYMBOL) == "^TNX"


def test_set_symbol_round_trips(session) -> None:
    svc.set_symbol(session, "^FVX")
    assert svc.get_symbol(session) == "^FVX"


def test_set_symbol_rejects_empty(session) -> None:
    with pytest.raises(ValueError, match="non-empty"):
        svc.set_symbol(session, "   ")


def test_get_returns_none_when_never_fetched(session) -> None:
    snap = svc.get_risk_free_rate(session, fetcher=_make_fetcher(None))
    assert snap.rate is None
    assert not snap.is_manual


def test_percent_quoted_yield_is_normalised(session) -> None:
    # ^IRX returns e.g. 5.21 meaning 5.21%;
    # service should store 0.0521.
    snap = svc.get_risk_free_rate(session, fetcher=_make_fetcher(Decimal("4.32")))
    assert snap.rate == Decimal("0.0432")
    assert snap.is_manual is False
    assert snap.fetched_at is not None
    # Persistence
    assert app_config_repo.get(session, svc.KEY_VALUE) == "0.0432"


def test_decimal_quoted_value_is_passed_through(session) -> None:
    snap = svc.get_risk_free_rate(session, fetcher=_make_fetcher(Decimal("0.045")))
    assert snap.rate == Decimal("0.045")


def test_cache_hit_within_ttl_skips_fetcher(session) -> None:
    calls = {"n": 0}

    def counting_fetcher(symbol: str):
        calls["n"] += 1
        return PriceRecord(symbol=symbol, date=datetime.now().date(), close=Decimal("5.0"))

    svc.get_risk_free_rate(session, fetcher=counting_fetcher)
    svc.get_risk_free_rate(session, fetcher=counting_fetcher)
    assert calls["n"] == 1


def test_cache_miss_after_ttl_refetches(session) -> None:
    calls = {"n": 0}

    def counting_fetcher(symbol: str):
        calls["n"] += 1
        return PriceRecord(symbol=symbol, date=datetime.now().date(), close=Decimal("5.0"))

    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    svc.get_risk_free_rate(session, fetcher=counting_fetcher, now=t0)
    svc.get_risk_free_rate(
        session,
        fetcher=counting_fetcher,
        now=t0 + timedelta(hours=25),
    )
    assert calls["n"] == 2


def test_manual_override_wins(session) -> None:
    svc.set_manual_rate(session, Decimal("0.04"))
    snap = svc.get_risk_free_rate(session, fetcher=_make_fetcher(Decimal("5.32")))
    assert snap.rate == Decimal("0.04")
    assert snap.is_manual is True


def test_manual_override_rejects_out_of_range(session) -> None:
    with pytest.raises(ValueError, match="rate"):
        svc.set_manual_rate(session, Decimal("2.0"))


def test_clearing_manual_override_falls_back_to_cached(session) -> None:
    svc.get_risk_free_rate(session, fetcher=_make_fetcher(Decimal("5.32")))
    svc.set_manual_rate(session, Decimal("0.04"))
    svc.set_manual_rate(session, None)
    snap = svc.get_risk_free_rate(session, fetcher=_make_fetcher(None))
    assert snap.rate == Decimal("0.0532")
    assert snap.is_manual is False


def test_fetch_failure_keeps_cached_value(session) -> None:
    svc.get_risk_free_rate(session, fetcher=_make_fetcher(Decimal("5.0")))
    # Older than TTL so we'd normally refetch; but fetcher now returns None.
    snap = svc.refresh(session, fetcher=_make_fetcher(None))
    assert snap.rate == Decimal("0.05")
