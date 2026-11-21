"""``/api/lookup``: search, quote and history with yfinance patched out."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.adapters import yfinance_client as yfc
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import instruments_repo
from investment_dashboard.services import lookup_service


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    lookup_service.clear_cache()
    yield
    lookup_service.clear_cache()


class _FakeSearch:
    def __init__(self, query: str, **kwargs: Any) -> None:
        self.quotes = [
            {
                "symbol": "vti",
                "longname": "Vanguard Total Stock Market ETF",
                "exchDisp": "NYSEArca",
                "quoteType": "ETF",
            },
            {"symbol": "ZZZ", "shortname": "Zed Corp", "exchange": "NMS", "typeDisp": "Equity"},
            {"shortname": "no symbol"},
        ]


class _FakeTicker:
    calls = 0

    def __init__(self, symbol: str) -> None:
        type(self).calls += 1
        self.fast_info = {
            "last_price": 110.0,
            "previous_close": 100.0,
            "year_low": 80.0,
            "year_high": 120.0,
            "currency": "usd",
            "exchange": "NMS",
            "quote_type": "equity",
        }
        self.info = {"longName": "Zed Corp", "fullExchangeName": "NasdaqGS", "quoteType": "EQUITY"}


@pytest.fixture
def fake_yf(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeTicker.calls = 0
    monkeypatch.setattr(yfc.yf, "Search", _FakeSearch)
    monkeypatch.setattr(yfc.yf, "Ticker", _FakeTicker)


def test_search_maps_hits_and_flags_held(api_client: TestClient, fake_yf: None) -> None:
    with ledger_session_scope() as s:
        held = instruments_repo.get_or_create(s, symbol="VTI", asset_class="etf").id
    body = api_client.get("/api/lookup/search", params={"q": "vanguard"}).json()
    rows = body["results"]
    assert [r["symbol"] for r in rows] == ["VTI", "ZZZ"]
    assert rows[0]["held_instrument_id"] == held
    assert rows[0]["name"] == "Vanguard Total Stock Market ETF"
    assert rows[0]["exchange"] == "NYSEArca"
    assert rows[0]["type"] == "ETF"
    assert rows[1]["held_instrument_id"] is None
    assert rows[1]["name"] == "Zed Corp"
    # Searching never creates a row.
    with ledger_session_scope() as s:
        assert {i.symbol for i in instruments_repo.list_instruments(s)} == {"VTI"}


def test_search_needs_a_query(api_client: TestClient, fake_yf: None) -> None:
    assert api_client.get("/api/lookup/search", params={"q": ""}).status_code == 422
    assert api_client.get("/api/lookup/search", params={"q": "x" * 200}).status_code == 422


def test_quote_and_cache_hit_then_expiry(
    api_client: TestClient, fake_yf: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [1000.0]
    monkeypatch.setattr(lookup_service, "_clock", lambda: now[0])
    first = api_client.get("/api/lookup/ZZZ/quote")
    assert first.status_code == 200, first.text
    q = first.json()
    assert q["price_native"] == "110.0"
    assert q["day_change_native"] == "10.0"
    assert Decimal(q["day_pct"]) == Decimal("0.1")
    assert q["week52_low"] == "80.0"
    assert q["week52_high"] == "120.0"
    assert q["currency"] == "USD"
    assert q["name"] == "Zed Corp"
    assert q["fx_eur_usd"] is None  # no FX history in the test DB
    assert _FakeTicker.calls == 1

    api_client.get("/api/lookup/ZZZ/quote")
    assert _FakeTicker.calls == 1  # served from cache

    now[0] += lookup_service.CACHE_TTL_SECONDS + 1
    api_client.get("/api/lookup/ZZZ/quote")
    assert _FakeTicker.calls == 2  # expired


def test_cache_keeps_at_most_50_symbols(monkeypatch: pytest.MonkeyPatch) -> None:
    for i in range(60):
        lookup_service._cache_put(f"S{i}", "quote", i)
    assert len(lookup_service._cache) == lookup_service.CACHE_MAX_SYMBOLS
    assert lookup_service._cache_get("S0", "quote") is None
    assert lookup_service._cache_get("S59", "quote") == 59


def test_history_daily_range_attaches_fx(
    api_client: TestClient, fake_yf: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, Any] = {}

    def fake_closes(symbols: list[str], start: date, end: date, **_: Any) -> dict[str, Any]:
        seen["start"] = start
        return {symbols[0]: {date(2026, 1, 5): Decimal("10"), date(2026, 1, 6): Decimal("11")}}

    monkeypatch.setattr(yfc, "fetch_closes", fake_closes)
    monkeypatch.setattr(
        lookup_service.fx_service,
        "get_rates",
        lambda session: {date(2026, 1, 2): Decimal("1.1")},
    )
    body = api_client.get("/api/lookup/ZZZ/history", params={"range": "3m"}).json()
    assert body["x_mode"] == "date"
    assert body["range"] == "3m"
    assert body["currency"] == "USD"
    assert body["sessions"] == []
    assert [p["t"] for p in body["points"]] == ["2026-01-05", "2026-01-06"]
    assert body["points"][0]["fx_eur_usd"] == "1.1"  # forward-filled
    assert seen["start"] < date.today()


def test_history_1d_returns_only_the_last_session(
    api_client: TestClient, fake_yf: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    day1 = datetime(2026, 1, 5, 14, 30)
    day2 = datetime(2026, 1, 6, 14, 30)
    bars = {
        symbol_time: Decimal(i)
        for i, symbol_time in enumerate(
            [day1, day1 + timedelta(minutes=1), day2, day2 + timedelta(minutes=1)]
        )
    }

    def fake_range(symbols: list[str], a: date, b: date, *, interval: str, **_: Any) -> Any:
        seen_interval.append(interval)
        return {symbols[0]: bars}

    seen_interval: list[str] = []
    monkeypatch.setattr(yfc, "fetch_intraday_closes_range", fake_range)
    one = api_client.get("/api/lookup/ZZZ/history", params={"range": "1d"}).json()
    assert one["x_mode"] == "time"
    assert len(one["sessions"]) == 1
    assert one["sessions"][0] == {"open": "2026-01-06T14:30:00Z", "close": "2026-01-06T14:31:00Z"}
    assert [p["price_native"] for p in one["points"]] == ["2", "3"]
    week = api_client.get("/api/lookup/ZZZ/history", params={"range": "1w"}).json()
    assert len(week["sessions"]) == 2
    assert len(week["points"]) == 4
    assert seen_interval == ["1m", "5m"]
    assert datetime.now(UTC)  # keep import used


def test_bad_symbol_and_range_are_422(api_client: TestClient, fake_yf: None) -> None:
    assert api_client.get("/api/lookup/abc/quote").status_code == 422
    assert api_client.get("/api/lookup/AB%20C/quote").status_code == 422
    assert api_client.get("/api/lookup/TOOLONGSYMBOL12345/quote").status_code == 422
    assert api_client.get("/api/lookup/ZZZ/history", params={"range": "5y"}).status_code == 422
    assert api_client.get("/api/lookup/BRK.B/quote").status_code == 200


def test_unknown_symbol_is_404(api_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(yfc, "fetch_quote", lambda symbol: None)
    assert api_client.get("/api/lookup/NOPE/quote").status_code == 404


def test_provider_failure_is_502_with_plain_message(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a: Any, **_k: Any) -> Any:
        raise yfc.YFinanceError("secret internal detail")

    monkeypatch.setattr(yfc, "fetch_quote", boom)
    monkeypatch.setattr(yfc, "search_instruments", boom)
    monkeypatch.setattr(yfc, "fetch_closes", boom)
    for url in ("/api/lookup/ZZZ/quote", "/api/lookup/search?q=a", "/api/lookup/ZZZ/history"):
        resp = api_client.get(url)
        assert resp.status_code == 502, url
        assert "secret" not in resp.text
        assert "not answering" in resp.json()["detail"]


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/lookup/ZZZ/quote").status_code == 401
