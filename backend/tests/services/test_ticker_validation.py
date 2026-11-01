"""Tests for the validated ticker-picking path (v2.8 item 3)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import InstrumentInfo, PriceRecord
from investment_dashboard.repositories import instruments_repo
from investment_dashboard.services import onboarding_service, ticker_validation_service


def _info(**kw: object) -> InstrumentInfo:
    base = {
        "symbol": "DAX",
        "long_name": "Global X DAX Germany ETF",
        "quote_type": "ETF",
        "currency": "USD",
        "expense_ratio": Decimal("0.0020"),
    }
    base.update(kw)
    return InstrumentInfo(**base)  # type: ignore[arg-type]


def _close(symbol: str = "DAX") -> PriceRecord:
    return PriceRecord(symbol=symbol, date=date(2026, 5, 29), close=Decimal("31.50"))


class TestValidateTicker:
    def test_valid_when_resolves_and_prices(self) -> None:
        res = ticker_validation_service.validate_ticker(
            "dax",
            info_fetcher=lambda s: _info(),
            close_fetcher=lambda s: _close(),
        )
        assert res.valid is True
        assert res.symbol == "DAX"  # normalised
        assert res.name == "Global X DAX Germany ETF"
        assert res.asset_class == "etf"
        assert res.native_currency == "USD"
        assert res.latest_close == Decimal("31.50")

    def test_blank_symbol_is_invalid(self) -> None:
        res = ticker_validation_service.validate_ticker("   ")
        assert res.valid is False

    def test_unresolved_symbol_is_invalid(self) -> None:
        res = ticker_validation_service.validate_ticker(
            "NOPE",
            info_fetcher=lambda s: None,
            close_fetcher=lambda s: None,
        )
        assert res.valid is False
        assert "did not resolve" in res.message

    def test_resolves_but_no_price_is_invalid(self) -> None:
        res = ticker_validation_service.validate_ticker(
            "DAX",
            info_fetcher=lambda s: _info(),
            close_fetcher=lambda s: None,
        )
        assert res.valid is False
        assert "no recent price" in res.message
        # Metadata still surfaced so the UI can explain the match.
        assert res.name == "Global X DAX Germany ETF"

    def test_strips_exchange_prefix_before_lookup(self) -> None:
        # Users paste Google/TradingView-style ``NASDAQ:DAX``; yfinance needs
        # the bare ``DAX`` ticker, so the prefix must be stripped before the
        # provider lookup (v2.9.6 DAX fix).
        seen: list[str] = []

        def info_fetcher(s: str) -> InstrumentInfo:
            seen.append(s)
            return _info()

        res = ticker_validation_service.validate_ticker(
            "NASDAQ:DAX",
            info_fetcher=info_fetcher,
            close_fetcher=lambda s: _close(),
        )
        assert seen == ["DAX"]
        assert res.symbol == "DAX"
        assert res.valid is True


class TestNormalizeSymbol:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("dax", "DAX"),
            ("  vti ", "VTI"),
            ("NASDAQ:DAX", "DAX"),
            ("nyse:brk.b", "BRK.B"),
            ("NYSEARCA:VOO", "VOO"),
            # An unknown prefix is left intact (don't mangle real symbols).
            ("FOO:BAR", "FOO:BAR"),
            # A trailing Yahoo exchange suffix is preserved.
            ("RHM.DE", "RHM.DE"),
        ],
    )
    def test_normalize(self, raw: str, expected: str) -> None:
        assert ticker_validation_service.normalize_symbol(raw) == expected


class TestAddValidatedInstrument:
    def test_persists_validated_instrument(self, session: Session) -> None:
        def fake_validate(symbol: str) -> ticker_validation_service.TickerValidation:
            return ticker_validation_service.validate_ticker(
                symbol,
                info_fetcher=lambda s: _info(),
                close_fetcher=lambda s: _close(),
            )

        result = onboarding_service.add_validated_instrument(
            session, "dax", category="DAX", validator=fake_validate
        )
        assert result.valid is True
        instr = instruments_repo.get_by_symbol(session, "DAX")
        assert instr is not None
        assert instr.asset_class == "etf"
        assert instr.native_currency == "USD"

    def test_rejects_invalid_ticker_and_writes_nothing(self, session: Session) -> None:
        def fake_validate(symbol: str) -> ticker_validation_service.TickerValidation:
            return ticker_validation_service.validate_ticker(
                symbol, info_fetcher=lambda s: None, close_fetcher=lambda s: None
            )

        with pytest.raises(onboarding_service.InvalidTickerError):
            onboarding_service.add_validated_instrument(session, "BOGUS", validator=fake_validate)
        assert instruments_repo.get_by_symbol(session, "BOGUS") is None
