"""Tests for the per-provider fetched-symbols report."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from investment_dashboard.services import fetch_report


@pytest.fixture(autouse=True)
def _clean() -> None:
    fetch_report.clear()
    yield
    fetch_report.clear()


def test_records_and_reads_back() -> None:
    fetch_report.record("yfinance", ["VTI", "AAPL"])
    report = fetch_report.get("yfinance")
    assert report is not None
    assert report.symbols == ("VTI", "AAPL")
    assert report.provider == "yfinance"


def test_deduplicates_preserving_order() -> None:
    fetch_report.record("yfinance", ["VTI", "AAPL", "VTI"])
    report = fetch_report.get("yfinance")
    assert report is not None
    assert report.symbols == ("VTI", "AAPL")


def test_empty_fetch_is_ignored() -> None:
    fetch_report.record("yfinance", ["VTI"])
    fetch_report.record("yfinance", [])  # no-op refresh must not erase the report
    report = fetch_report.get("yfinance")
    assert report is not None
    assert report.symbols == ("VTI",)


def test_providers_are_independent() -> None:
    fetch_report.record("yfinance", ["VTI"])
    fetch_report.record("frankfurter", ["EUR/USD"])
    snapshot = fetch_report.all_latest()
    assert snapshot["yfinance"].symbols == ("VTI",)
    assert snapshot["frankfurter"].symbols == ("EUR/USD",)


def test_record_uses_supplied_timestamp() -> None:
    when = datetime(2024, 6, 24, 12, 0, tzinfo=UTC)
    fetch_report.record("yfinance", ["VTI"], at=when)
    report = fetch_report.get("yfinance")
    assert report is not None
    assert report.at == when


def test_unknown_provider_is_none() -> None:
    assert fetch_report.get("nope") is None
