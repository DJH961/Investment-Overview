"""Tests for the live EUR/USD spot overlay (keyless yfinance FX for desktop).

The desktop has no Twelve Data token, so the live intraday EUR/USD comes from
yfinance's ``EURUSD=X`` and is overlaid onto the ECB daily history for *today
only*. These tests pin that the overlay moves the current day while every
historical mark (and therefore the golden-master daily figures) stays put.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
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

#: A weekday instant well inside spot-FX trading hours (Wed 11:00 ET), so the
#: forex-open gate lets the Tiingo *live* backup engage. The backup must never be
#: consulted while the market is closed (see ``test_..._market_closed`` below).
_FX_OPEN_NOW = datetime(2024, 6, 12, 15, 0, tzinfo=UTC)


def _tiingo_fx(rate: str, value_date: date | None) -> object:
    from investment_dashboard.adapters.tiingo_client import TiingoFxQuote

    return TiingoFxQuote(
        base="EUR",
        quote="USD",
        rate=Decimal(rate),
        as_of=None,
        value_date=value_date,
    )


def test_refresh_live_spot_skips_tiingo_when_forex_market_closed() -> None:
    # Saturday: spot-FX is dark, so even a stale yfinance reading must not route
    # to Tiingo — there is no live quote to fetch, the ECB rate simply stands.
    called = False

    def tiingo() -> object:
        nonlocal called
        called = True
        return _tiingo_fx("1.1382", date.today())

    rate = fx_service.refresh_live_spot(
        fetcher=lambda: None,
        now=datetime(2024, 6, 8, 15, 0, tzinfo=UTC),  # Saturday
        tiingo_fetcher=tiingo,
        tiingo_token="tok",
        charge_budget=lambda: True,
    )
    assert rate is None
    assert called is False  # forex closed ⇒ Tiingo never consulted


def test_refresh_live_spot_falls_back_to_tiingo_when_yfinance_stale() -> None:
    yesterday = date.today() - timedelta(days=1)

    def stale_yf() -> PriceRecord:
        return PriceRecord(symbol="EURUSD=X", date=yesterday, close=Decimal("1.07"))

    rate = fx_service.refresh_live_spot(
        fetcher=stale_yf,
        now=_FX_OPEN_NOW,
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
        now=_FX_OPEN_NOW,
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
        now=_FX_OPEN_NOW,
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
        now=_FX_OPEN_NOW,
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
        now=_FX_OPEN_NOW,
        tiingo_fetcher=boom,
        tiingo_token="tok",
        charge_budget=lambda: True,
    )
    assert rate is None


class TestEurQuoteAsOf:
    """``eur_quote_as_of`` reports *which day's* EUR/USD rate the UI is showing —
    a live today-dated spot vs the settled ECB end-of-day reference rate — so the
    desktop can stamp an honest "as of …" / "EOD FX" provenance label."""

    def test_none_when_no_rate_at_all(self, session: Session) -> None:
        assert fx_service.eur_quote_as_of(session, today=date.today()) is None

    def test_live_spot_reports_live_as_of_today(self, session: Session) -> None:
        today = date.today()
        fx_repo.upsert_rates(
            session, {today - timedelta(days=1): Decimal("1.10")}, base="EUR", quote="USD"
        )
        session.flush()
        observed = datetime(today.year, today.month, today.day, 18, 42, tzinfo=UTC)
        fx_service.set_live_spot("USD", Decimal("1.15"), observed_on=today, observed_at=observed)

        info = fx_service.eur_quote_as_of(session, today=today)
        assert info is not None
        assert info.source == "live"
        assert info.is_live is True
        assert info.as_of == today
        # The capture instant rides along for the UI's live "as of HH:MM" clock.
        assert info.observed_at == observed

    def test_set_live_spot_defaults_observed_at_to_now(self, session: Session) -> None:
        today = date.today()
        before = datetime.now(UTC)
        fx_service.set_live_spot("USD", Decimal("1.15"), observed_on=today)
        spot = fx_service.get_live_spot("USD")
        assert spot is not None
        assert spot.observed_at is not None
        assert spot.observed_at >= before

    def test_eod_reports_latest_settled_date(self, session: Session) -> None:
        today = date.today()
        friday = today - timedelta(days=3)
        fx_repo.upsert_rates(session, {friday: Decimal("1.08")}, base="EUR", quote="USD")
        session.flush()
        # No live spot ⇒ the displayed rate forward-fills from Friday's ECB fixing.

        info = fx_service.eur_quote_as_of(session, today=today)
        assert info is not None
        assert info.source == "eod"
        assert info.is_live is False
        assert info.as_of == friday

    def test_stale_live_spot_falls_back_to_eod(self, session: Session) -> None:
        today = date.today()
        yesterday = today - timedelta(days=1)
        fx_repo.upsert_rates(session, {yesterday: Decimal("1.09")}, base="EUR", quote="USD")
        session.flush()
        # A spot observed yesterday is not today's live overlay (see get_rates).
        fx_service.set_live_spot("USD", Decimal("1.20"), observed_on=yesterday)

        info = fx_service.eur_quote_as_of(session, today=today)
        assert info is not None
        assert info.source == "eod"
        assert info.as_of == yesterday
