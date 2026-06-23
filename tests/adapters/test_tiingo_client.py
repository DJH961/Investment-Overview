"""Unit tests for the Tiingo fallback adapter, with mocked HTTP (respx)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import httpx
import pytest
import respx

from investment_dashboard.adapters.tiingo_client import (
    TIINGO_ROOT,
    TiingoError,
    fetch_closes,
    fetch_fx_rate,
    fetch_latest_close,
    fetch_quotes,
)
from investment_dashboard.services import provider_status

_TOKEN = "test-token-123"


@pytest.fixture(autouse=True)
def _clear_status() -> None:
    provider_status.reset()


@respx.mock
def test_fetch_quotes_parses_equity_and_fund() -> None:
    route = respx.get(f"{TIINGO_ROOT}/iex/").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "ticker": "AAPL",
                    "tngoLast": 201.5,
                    "last": 201.4,
                    "prevClose": 200.0,
                    "timestamp": "2026-06-22T20:00:00+00:00",
                },
                {
                    "ticker": "FSKAX",
                    "tngoLast": 206.15,
                    "prevClose": 206.85,
                    "timestamp": "2026-06-22T20:00:00.000Z",
                },
            ],
        )
    )

    quotes = fetch_quotes(["AAPL", "FSKAX"], token=_TOKEN)

    assert route.called
    # Token rides the Authorization header, never the URL.
    assert route.calls.last.request.headers["Authorization"] == f"Token {_TOKEN}"
    assert "token" not in str(route.calls.last.request.url).lower()

    assert set(quotes) == {"AAPL", "FSKAX"}
    aapl = quotes["AAPL"]
    assert aapl.price == Decimal("201.5")
    assert aapl.previous_close == Decimal("200.0")
    assert aapl.value_date == date(2026, 6, 22)
    assert aapl.as_of == datetime(2026, 6, 22, 20, 0, 0)

    fskax = quotes["FSKAX"]
    assert fskax.price == Decimal("206.15")
    assert fskax.previous_close == Decimal("206.85")
    assert isinstance(fskax.price, Decimal)


@respx.mock
def test_fetch_quotes_skips_unknown_ticker_without_price() -> None:
    respx.get(f"{TIINGO_ROOT}/iex/").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "ticker": "AAPL",
                    "tngoLast": 201.5,
                    "prevClose": 200.0,
                    "timestamp": "2026-06-22T20:00:00Z",
                },
                {"ticker": "NOTREAL"},  # echoed back with no price
            ],
        )
    )

    quotes = fetch_quotes(["AAPL", "NOTREAL"], token=_TOKEN)

    assert set(quotes) == {"AAPL"}


@respx.mock
def test_fetch_quotes_empty_symbols_makes_no_call() -> None:
    route = respx.get(f"{TIINGO_ROOT}/iex/")
    assert fetch_quotes([], token=_TOKEN) == {}
    assert not route.called


@respx.mock
def test_fetch_closes_parses_daily_rows() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/daily/FSKAX/prices").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"date": "2026-06-19T00:00:00.000Z", "close": 205.40},
                {"date": "2026-06-22T00:00:00.000Z", "close": 206.15},
            ],
        )
    )

    out = fetch_closes(["FSKAX"], date(2026, 6, 19), date(2026, 6, 22), token=_TOKEN)

    assert out["FSKAX"] == {
        date(2026, 6, 19): Decimal("205.4"),
        date(2026, 6, 22): Decimal("206.15"),
    }


@respx.mock
def test_fetch_closes_unknown_ticker_404_is_empty_not_error() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/daily/EXS1.DE/prices").mock(
        return_value=httpx.Response(404, json={"detail": "Not found"})
    )

    out = fetch_closes(["EXS1.DE"], date(2026, 6, 19), date(2026, 6, 22), token=_TOKEN)

    assert out == {"EXS1.DE": {}}
    # A non-US miss is graceful, surfaced as a non-fatal status, not a raise.
    assert provider_status.get_status("tiingo").status == "error"


@respx.mock
def test_fetch_closes_partial_status() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/daily/FSKAX/prices").mock(
        return_value=httpx.Response(200, json=[{"date": "2026-06-22T00:00:00Z", "close": 206.15}])
    )
    respx.get(f"{TIINGO_ROOT}/tiingo/daily/NOPE/prices").mock(return_value=httpx.Response(404))

    out = fetch_closes(["FSKAX", "NOPE"], date(2026, 6, 19), date(2026, 6, 22), token=_TOKEN)

    assert out["FSKAX"]
    assert out["NOPE"] == {}
    assert provider_status.get_status("tiingo").status == "partial"


@respx.mock
def test_fetch_closes_5xx_raises() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/daily/FSKAX/prices").mock(
        return_value=httpx.Response(503, text="upstream down")
    )
    with pytest.raises(TiingoError):
        fetch_closes(["FSKAX"], date(2026, 6, 19), date(2026, 6, 22), token=_TOKEN)


@respx.mock
def test_fetch_latest_close_returns_newest_row() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/daily/FSKAX/prices").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"date": "2026-06-19T00:00:00Z", "close": 205.40},
                {"date": "2026-06-22T00:00:00Z", "close": 206.15},
            ],
        )
    )

    latest = fetch_latest_close("FSKAX", token=_TOKEN)

    assert latest == (date(2026, 6, 22), Decimal("206.15"))


@respx.mock
def test_fetch_latest_close_none_when_empty() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/daily/FSKAX/prices").mock(
        return_value=httpx.Response(200, json=[])
    )
    assert fetch_latest_close("FSKAX", token=_TOKEN) is None


def test_empty_token_is_rejected() -> None:
    with pytest.raises(TiingoError):
        fetch_quotes(["AAPL"], token="")


# --- FX top-of-book (live EUR/USD backup) ----------------------------------


@respx.mock
def test_fetch_fx_rate_parses_mid_and_timestamp() -> None:
    route = respx.get(f"{TIINGO_ROOT}/tiingo/fx/top").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "ticker": "eurusd",
                    "quoteTimestamp": "2026-06-23T16:06:52.450000+00:00",
                    "bidPrice": 1.13818,
                    "askPrice": 1.13819,
                    "midPrice": 1.138185,
                }
            ],
        )
    )

    reading = fetch_fx_rate(base="EUR", quote="USD", token=_TOKEN)

    assert route.called
    # Pair is requested lowercase-concatenated; token rides the header.
    assert route.calls.last.request.url.params["tickers"] == "eurusd"
    assert route.calls.last.request.headers["Authorization"] == f"Token {_TOKEN}"
    assert reading is not None
    # midPrice is USD per 1 EUR — used directly, no inversion.
    assert reading.rate == Decimal("1.138185")
    assert reading.base == "EUR"
    assert reading.quote == "USD"
    assert reading.value_date == date(2026, 6, 23)
    assert reading.as_of == datetime(2026, 6, 23, 16, 6, 52, 450000)


@respx.mock
def test_fetch_fx_rate_falls_back_to_bid_ask_midpoint() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/fx/top").mock(
        return_value=httpx.Response(
            200,
            json=[{"ticker": "eurusd", "bidPrice": 1.10, "askPrice": 1.20}],
        )
    )

    reading = fetch_fx_rate(base="EUR", quote="USD", token=_TOKEN)
    assert reading is not None
    assert reading.rate == Decimal("1.15")


@respx.mock
def test_fetch_fx_rate_empty_array_returns_none() -> None:
    # Tiingo returns [] for the unquoted direction (e.g. usdeur) — graceful None.
    respx.get(f"{TIINGO_ROOT}/tiingo/fx/top").mock(return_value=httpx.Response(200, json=[]))

    assert fetch_fx_rate(base="USD", quote="EUR", token=_TOKEN) is None


@respx.mock
def test_fetch_fx_rate_raises_on_server_error() -> None:
    respx.get(f"{TIINGO_ROOT}/tiingo/fx/top").mock(return_value=httpx.Response(500, text="boom"))
    with pytest.raises(TiingoError):
        fetch_fx_rate(base="EUR", quote="USD", token=_TOKEN)


def test_fetch_fx_rate_rejects_malformed_pair() -> None:
    with pytest.raises(ValueError, match="ISO currency"):
        fetch_fx_rate(base="EU", quote="USD", token=_TOKEN)
