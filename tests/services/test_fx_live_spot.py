"""Tests for the live EUR/USD spot overlay (keyless yfinance FX for desktop).

The desktop has no Twelve Data token, so the live intraday EUR/USD comes from
yfinance's ``EURUSD=X`` and is overlaid onto the ECB daily history for *today
only*. These tests pin that the overlay moves the current day while every
historical mark (and therefore the golden-master daily figures) stays put.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import PriceRecord
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import fx_service


@pytest.fixture(autouse=True)
def _clear_live_spot() -> object:
    """Keep the process-local live-spot store from leaking across tests."""
    fx_service.clear_live_spot()
    yield
    fx_service.clear_live_spot()


def test_get_rates_overlays_live_spot_for_today_only(session: Session) -> None:
    yesterday = date.today() - timedelta(days=1)
    fx_repo.upsert_rates(
        session,
        {yesterday: Decimal("1.10"), date.today(): Decimal("1.11")},
        base="EUR",
        quote="USD",
    )
    session.flush()

    fx_service.set_live_spot("USD", Decimal("1.1500"), observed_on=date.today())
    rates = fx_service.get_rates(session, base="EUR", quote="USD")
    # Today's mark reflects the live spot; yesterday's ECB mark is untouched.
    assert rates[date.today()] == Decimal("1.1500")
    assert rates[yesterday] == Decimal("1.10")


def test_live_spot_does_not_alter_historical_lookups(session: Session) -> None:
    past = date(2024, 1, 5)
    fx_repo.upsert_rates(
        session,
        {past: Decimal("1.20"), date.today(): Decimal("1.11")},
        base="EUR",
        quote="USD",
    )
    session.flush()

    fx_service.set_live_spot("USD", Decimal("1.30"), observed_on=date.today())
    # A past-date lookup forward-fills from stored history, never the live spot.
    assert fx_service.get_rate_eur_to_quote(session, past) == Decimal("1.20")
    assert fx_service.get_rate_eur_to_quote(session, date.today()) == Decimal("1.30")


def test_refresh_live_spot_stores_a_today_dated_reading() -> None:
    def fake_fetch() -> PriceRecord:
        return PriceRecord(symbol="EURUSD=X", date=date.today(), close=Decimal("1.0825"))

    rate = fx_service.refresh_live_spot(fetcher=fake_fetch)
    assert rate == Decimal("1.0825")
    spot = fx_service.get_live_spot("USD")
    assert spot is not None
    assert spot.rate == Decimal("1.0825")
    assert spot.observed_on == date.today()


def test_refresh_live_spot_ignores_a_stale_reading() -> None:
    yesterday = date.today() - timedelta(days=1)

    def fake_fetch() -> PriceRecord:
        return PriceRecord(symbol="EURUSD=X", date=yesterday, close=Decimal("1.07"))

    # A pre-today close (weekend/holiday) must not masquerade as a live spot.
    assert fx_service.refresh_live_spot(fetcher=fake_fetch) is None
    assert fx_service.get_live_spot("USD") is None


def test_refresh_live_spot_handles_missing_feed() -> None:
    assert fx_service.refresh_live_spot(fetcher=lambda: None) is None
    assert fx_service.get_live_spot("USD") is None


def test_refresh_live_spot_swallows_fetch_errors() -> None:
    def boom() -> PriceRecord:
        raise RuntimeError("network down")

    assert fx_service.refresh_live_spot(fetcher=boom) is None
    assert fx_service.get_live_spot("USD") is None


def test_refresh_live_spot_only_sources_usd() -> None:
    called = False

    def fake_fetch() -> PriceRecord:
        nonlocal called
        called = True
        return PriceRecord(symbol="EURUSD=X", date=date.today(), close=Decimal("1.08"))

    assert fx_service.refresh_live_spot(quote="DKK", fetcher=fake_fetch) is None
    assert called is False


# --- Tiingo secondary live-FX provider -------------------------------------


def _tiingo_fx(rate: str, value_date: date | None) -> object:
    from investment_dashboard.adapters.tiingo_client import TiingoFxQuote

    return TiingoFxQuote(
        base="EUR",
        quote="USD",
        rate=Decimal(rate),
        as_of=None,
        value_date=value_date,
    )


def test_refresh_live_spot_falls_back_to_tiingo_when_yfinance_stale() -> None:
    yesterday = date.today() - timedelta(days=1)

    def stale_yf() -> PriceRecord:
        return PriceRecord(symbol="EURUSD=X", date=yesterday, close=Decimal("1.07"))

    rate = fx_service.refresh_live_spot(
        fetcher=stale_yf,
        tiingo_fetcher=lambda: _tiingo_fx("1.1382", date.today()),
        tiingo_token="tok",
        charge_budget=lambda: True,
    )
    assert rate == Decimal("1.1382")
    spot = fx_service.get_live_spot("USD")
    assert spot is not None
    assert spot.rate == Decimal("1.1382")
    assert spot.observed_on == date.today()


def test_refresh_live_spot_prefers_yfinance_over_tiingo() -> None:
    tiingo_called = False

    def tiingo() -> object:
        nonlocal tiingo_called
        tiingo_called = True
        return _tiingo_fx("9.99", date.today())

    rate = fx_service.refresh_live_spot(
        fetcher=lambda: PriceRecord(symbol="EURUSD=X", date=date.today(), close=Decimal("1.08")),
        tiingo_fetcher=tiingo,
        tiingo_token="tok",
        charge_budget=lambda: True,
    )
    assert rate == Decimal("1.08")
    assert tiingo_called is False  # primary succeeded; backup never consulted


def test_refresh_live_spot_skips_tiingo_without_token() -> None:
    called = False

    def tiingo() -> object:
        nonlocal called
        called = True
        return _tiingo_fx("1.13", date.today())

    rate = fx_service.refresh_live_spot(
        fetcher=lambda: None,
        tiingo_fetcher=tiingo,
        tiingo_token="",  # no token configured ⇒ no backup
        charge_budget=lambda: True,
    )
    assert rate is None
    assert called is False


def test_refresh_live_spot_skips_tiingo_when_budget_exhausted() -> None:
    called = False

    def tiingo() -> object:
        nonlocal called
        called = True
        return _tiingo_fx("1.13", date.today())

    rate = fx_service.refresh_live_spot(
        fetcher=lambda: None,
        tiingo_fetcher=tiingo,
        tiingo_token="tok",
        charge_budget=lambda: False,  # budget spent
    )
    assert rate is None
    assert called is False


def test_refresh_live_spot_rejects_stale_tiingo_reading() -> None:
    yesterday = date.today() - timedelta(days=1)
    rate = fx_service.refresh_live_spot(
        fetcher=lambda: None,
        tiingo_fetcher=lambda: _tiingo_fx("1.13", yesterday),
        tiingo_token="tok",
        charge_budget=lambda: True,
    )
    assert rate is None
    assert fx_service.get_live_spot("USD") is None


def test_refresh_live_spot_swallows_tiingo_errors() -> None:
    def boom() -> object:
        raise RuntimeError("tiingo down")

    rate = fx_service.refresh_live_spot(
        fetcher=lambda: None,
        tiingo_fetcher=boom,
        tiingo_token="tok",
        charge_budget=lambda: True,
    )
    assert rate is None
