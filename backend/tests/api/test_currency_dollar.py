"""Tests for ``GET /api/currency/dollar/both`` and ``/api/currency/scenarios/both`` (v7.2).

Synthetic ledger (``_seed``) plus a synthetic ~12-year daily rate history; no
network, no real data.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import fx_service

from ._seed import seed_ledger


def _history(today: date, existing: set[date]) -> dict[date, Decimal]:
    """Weekdays for ~12 years: a slow zig-zag between 1.00 and 1.30 (4 dp)."""
    out: dict[date, Decimal] = {}
    day = today - timedelta(days=12 * 365)
    i = 0
    while day < today:
        if day.weekday() < 5 and day not in existing:
            phase = i % 600
            step = phase if phase < 300 else 600 - phase
            out[day] = Decimal("1.0000") + Decimal(step) / 1000
            i += 1
        day += timedelta(days=1)
    return out


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    today = exchange_today()
    with ledger_session_scope() as session:
        seed_ledger(session)
        existing = set(fx_repo.get_rates(session))
        fx_repo.upsert_rates(session, _history(today, existing))
    fx_service.clear_live_spot()
    yield
    fx_service.clear_live_spot()


def _get(client: TestClient, path: str) -> dict[str, Any]:
    resp = client.get(path)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


@pytest.mark.parametrize("path", ["/api/currency/dollar/both", "/api/currency/scenarios/both"])
def test_requires_auth(anon_client: TestClient, path: str) -> None:
    assert anon_client.get(path).status_code == 401


def test_dollar_unknown_range_is_rejected(api_client: TestClient, seeded: None) -> None:
    assert api_client.get("/api/currency/dollar/both?range=2y").status_code == 422


def test_dollar_shape_and_quote(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/dollar/both?range=1y")
    assert body["EUR"]["quote"] == {"pair": "USD/EUR", "field": "inverse"}
    assert body["USD"]["quote"] == {"pair": "EUR/USD", "field": "rate"}
    for ccy in ("EUR", "USD"):
        assert body[ccy]["ccy"] == ccy
        assert body[ccy]["range"] == "1y"
        assert "does not predict" in body[ccy]["caption"]


def test_scenarios_shape(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/scenarios/both")
    for ccy in ("EUR", "USD"):
        side = body[ccy]
        assert Decimal(side["min_rate"]) == Decimal("0.90")
        assert Decimal(side["max_rate"]) == Decimal("1.60")


def test_etag_round_trip(api_client: TestClient, seeded: None) -> None:
    for path in ("/api/currency/dollar/both?range=1y", "/api/currency/scenarios/both"):
        first = api_client.get(path)
        etag = first.headers.get("etag")
        assert etag
        again = api_client.get(path, headers={"If-None-Match": etag})
        assert again.status_code == 304
