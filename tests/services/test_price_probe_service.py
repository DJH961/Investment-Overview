"""Tests for the one-shot single-symbol price-probe service."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.adapters._retry import RateLimitedError
from investment_dashboard.services import price_probe_service as probe


def test_yfinance_ok() -> None:
    outcome = probe.probe_yfinance(
        "VTI", fetcher=lambda _s: (date(2026, 1, 2), Decimal("250.5"))
    )
    assert outcome.verdict == "ok"
    assert outcome.price == Decimal("250.5")
    assert outcome.as_of == date(2026, 1, 2)
    assert outcome.provider == "yfinance"


def test_yfinance_no_quote() -> None:
    outcome = probe.probe_yfinance("BOGUS", fetcher=lambda _s: None)
    assert outcome.verdict == "no-quote"
    assert outcome.price is None


def test_yfinance_unreachable() -> None:
    def _boom(_s: str) -> None:
        raise RuntimeError("network down")

    outcome = probe.probe_yfinance("VTI", fetcher=_boom)
    assert outcome.verdict == "unreachable"
    assert "network down" in outcome.detail


def test_tiingo_not_configured_without_token() -> None:
    outcome = probe.probe_tiingo("VTI", token=None, fetcher=lambda _s, _t: None)
    assert outcome.verdict == "not-configured"
    assert outcome.price is None


def test_tiingo_ok() -> None:
    outcome = probe.probe_tiingo(
        "VTI", token="tok", fetcher=lambda _s, _t: (date(2026, 1, 3), Decimal("12.34"))
    )
    assert outcome.verdict == "ok"
    assert outcome.price == Decimal("12.34")
    assert outcome.as_of == date(2026, 1, 3)


def test_tiingo_no_quote() -> None:
    outcome = probe.probe_tiingo("BOGUS", token="tok", fetcher=lambda _s, _t: None)
    assert outcome.verdict == "no-quote"


def test_tiingo_rate_limited() -> None:
    def _limited(_s: str, _t: str) -> None:
        raise RateLimitedError("HTTP 429")

    outcome = probe.probe_tiingo("VTI", token="tok", fetcher=_limited)
    assert outcome.verdict == "rate-limited"


def test_tiingo_unreachable() -> None:
    def _boom(_s: str, _t: str) -> None:
        raise RuntimeError("dns failure")

    outcome = probe.probe_tiingo("VTI", token="tok", fetcher=_boom)
    assert outcome.verdict == "unreachable"
    assert "dns failure" in outcome.detail


def test_provider_labels() -> None:
    assert "yfinance" in probe.probe_provider_label("yfinance")
    assert "Tiingo" in probe.probe_provider_label("tiingo")
