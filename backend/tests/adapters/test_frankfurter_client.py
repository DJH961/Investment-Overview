"""Unit tests for the Frankfurter FX adapter, with mocked HTTP."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import httpx
import pytest
import respx

from investment_dashboard.adapters.frankfurter_client import (
    BASE_URL,
    FrankfurterError,
    fetch_latest,
    fetch_rates,
)


@respx.mock
def test_fetch_rates_parses_multi_day_response() -> None:
    route = respx.get(f"{BASE_URL}/2024-01-02..2024-01-05").mock(
        return_value=httpx.Response(
            200,
            json={
                "amount": 1.0,
                "base": "EUR",
                "start_date": "2024-01-02",
                "end_date": "2024-01-05",
                "rates": {
                    "2024-01-02": {"USD": 1.0956},
                    "2024-01-03": {"USD": 1.0921},
                    "2024-01-04": {"USD": 1.0945},
                    "2024-01-05": {"USD": 1.0972},
                },
            },
        )
    )

    records = fetch_rates(date(2024, 1, 2), date(2024, 1, 5))

    assert route.called
    assert [r.date for r in records] == [
        date(2024, 1, 2),
        date(2024, 1, 3),
        date(2024, 1, 4),
        date(2024, 1, 5),
    ]
    assert records[0].base == "EUR"
    assert records[0].quote == "USD"
    assert records[0].rate == Decimal("1.0956")
    assert all(isinstance(r.rate, Decimal) for r in records)


@respx.mock
def test_fetch_rates_skips_weekends() -> None:
    # Frankfurter just omits weekends; we surface that as-is.
    respx.get(f"{BASE_URL}/2024-06-07..2024-06-10").mock(
        return_value=httpx.Response(
            200,
            json={
                "base": "EUR",
                "rates": {
                    "2024-06-07": {"USD": 1.08},
                    "2024-06-10": {"USD": 1.078},
                },
            },
        )
    )
    records = fetch_rates(date(2024, 6, 7), date(2024, 6, 10))
    assert [r.date for r in records] == [date(2024, 6, 7), date(2024, 6, 10)]


@respx.mock
def test_fetch_rates_raises_on_http_error() -> None:
    respx.get(f"{BASE_URL}/2024-01-01..2024-01-02").mock(
        return_value=httpx.Response(503, text="Service Unavailable")
    )
    with pytest.raises(FrankfurterError):
        fetch_rates(date(2024, 1, 1), date(2024, 1, 2))


@respx.mock
def test_fetch_rates_returns_empty_on_404_unpublished_window() -> None:
    # Frankfurter answers a window with no published rates yet (e.g. a
    # single-day request for today before the ECB publishes) with a 404.
    # We treat that as a benign "nothing new", not an error.
    route = respx.get(f"{BASE_URL}/2026-06-24..2026-06-24").mock(
        return_value=httpx.Response(404, json={"message": "not found"})
    )
    records = fetch_rates(date(2026, 6, 24), date(2026, 6, 24))
    assert route.called
    assert records == []


@respx.mock
def test_fetch_rates_raises_on_malformed_payload() -> None:
    respx.get(f"{BASE_URL}/2024-01-01..2024-01-02").mock(
        return_value=httpx.Response(200, json={"unexpected": "shape"})
    )
    with pytest.raises(FrankfurterError):
        fetch_rates(date(2024, 1, 1), date(2024, 1, 2))


@respx.mock
def test_fetch_rates_raises_on_network_error() -> None:
    respx.get(f"{BASE_URL}/2024-01-01..2024-01-02").mock(side_effect=httpx.ConnectError("boom"))
    with pytest.raises(FrankfurterError):
        fetch_rates(date(2024, 1, 1), date(2024, 1, 2))


def test_fetch_rates_validates_inputs() -> None:
    with pytest.raises(ValueError, match="precedes start"):
        fetch_rates(date(2024, 6, 5), date(2024, 6, 1))
    with pytest.raises(ValueError, match="3 letters"):
        fetch_rates(date(2024, 1, 1), date(2024, 1, 2), base="EURX")


@respx.mock
def test_fetch_latest() -> None:
    respx.get(f"{BASE_URL}/latest").mock(
        return_value=httpx.Response(
            200,
            json={"base": "EUR", "date": "2024-06-14", "rates": {"USD": 1.07123456}},
        )
    )
    rec = fetch_latest()
    assert rec.date == date(2024, 6, 14)
    assert rec.rate == Decimal("1.07123456")


@pytest.mark.network
def test_fetch_latest_live_smoke() -> None:
    rec = fetch_latest()
    assert rec.base == "EUR"
    assert rec.quote == "USD"
    assert rec.rate > 0
