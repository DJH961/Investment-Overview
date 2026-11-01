"""Tests for ``GET /api/graphs/{range}``."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.services import intraday_snapshots_service

from ._seed import seed_ledger

DAILY_RANGES = ["1m", "3m", "6m", "ytd", "1y", "all"]


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


@pytest.fixture
def offline_intraday(monkeypatch: pytest.MonkeyPatch) -> None:
    """Serve fixed intraday samples so no test touches the price feed."""
    samples = [
        (datetime(2026, 10, 30, 14, 30), Decimal("4000"), Decimal("1.2")),
        (datetime(2026, 10, 30, 15, 30), Decimal("4100"), Decimal("1.2")),
        (datetime(2026, 10, 30, 19, 55), Decimal("4200"), Decimal("1.2")),
    ]
    monkeypatch.setattr(
        intraday_snapshots_service, "day_series_with_fx", lambda *_a, **_k: list(samples)
    )
    monkeypatch.setattr(
        intraday_snapshots_service, "week_series_with_fx", lambda *_a, **_k: list(samples)
    )
    monkeypatch.setattr(intraday_snapshots_service, "week_nav_drift_with_fx", lambda *_a, **_k: {})


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/graphs/1m").status_code == 401


@pytest.mark.parametrize("range_key", DAILY_RANGES)
def test_daily_ranges(api_client: TestClient, seeded: None, range_key: str) -> None:
    body = api_client.get(f"/api/graphs/{range_key}?ccy=USD").json()
    assert body["range"] == range_key
    assert body["ccy"] == "USD"
    assert body["intraday"] is False
    assert body["as_of"] == exchange_today().isoformat()
    assert body["reference"] is None
    assert body["secondary"] is None
    points = body["points"]
    assert points, "the seeded ledger has a priced history"
    dates = [p["t"] for p in points]
    assert dates == sorted(dates)
    assert len(set(dates)) == len(dates)
    assert len(dates[0]) == 10  # a plain date, not a timestamp
    # USD is the booked currency: the latest close is FX-free (15 VTI x 250 + 20 BND x 70).
    assert Decimal(points[-1]["v"]) == Decimal(5150)


def test_eur_line_uses_that_days_rate_and_compare_returns_other_ccy(
    api_client: TestClient, seeded: None
) -> None:
    body = api_client.get("/api/graphs/1m?ccy=EUR&compare=true").json()
    assert body["ccy"] == "EUR"
    secondary = body["secondary"]
    assert secondary["ccy"] == "USD"
    assert [p["t"] for p in secondary["points"]] == [p["t"] for p in body["points"]]
    # Each EUR point is that day's USD value over that day's rate (never one global rate).
    assert Decimal(body["points"][-1]["v"]) < Decimal(secondary["points"][-1]["v"])
    assert body["points"][-1]["v"] != secondary["points"][-1]["v"]


def test_longer_ranges_never_have_fewer_points(api_client: TestClient, seeded: None) -> None:
    sizes = {
        key: len(api_client.get(f"/api/graphs/{key}").json()["points"]) for key in DAILY_RANGES
    }
    assert sizes["1m"] <= sizes["3m"] <= sizes["6m"] <= sizes["1y"] <= sizes["all"]


def test_one_day_is_intraday_with_reference(
    api_client: TestClient, seeded: None, offline_intraday: None
) -> None:
    body = api_client.get("/api/graphs/1d?ccy=USD").json()
    assert body["intraday"] is True
    assert body["points"], "intraday samples plus the live tip"
    assert "T" in body["points"][0]["t"]  # a UTC timestamp, not a date
    assert body["points"][0]["t"].endswith(("Z", "+00:00"))
    assert body["reference"] is not None


def test_one_week_is_intraday(api_client: TestClient, seeded: None, offline_intraday: None) -> None:
    body = api_client.get("/api/graphs/1w?ccy=EUR&compare=true").json()
    assert body["intraday"] is True
    assert body["points"]
    assert body["reference"] is None


def test_one_day_empty_ledger(api_client: TestClient, api_db: object) -> None:
    body = api_client.get("/api/graphs/1d").json()
    assert body["points"] == []


@pytest.mark.parametrize("path", ["/api/graphs/2w", "/api/graphs/1m?ccy=GBP", "/api/graphs/ALL"])
def test_bad_input_is_422(api_client: TestClient, path: str) -> None:
    assert api_client.get(path).status_code == 422
