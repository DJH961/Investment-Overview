"""``/api/calculator`` routes."""

from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )


def test_get_inputs(api_client: TestClient) -> None:
    body = api_client.get("/api/calculator?ccy=USD").json()
    assert body["ccy"] == "USD"
    assert body["instruments"] == []
    assert body["projection_defaults"]["year"]["monthly"] is False
    assert body["projection_defaults"]["month"]["monthly"] is True


def test_projection_hand_checked(api_client: TestClient) -> None:
    # Empty portfolio: start 0, contribute 100 / year for 2 years at 10 % (annual,
    # contribution at period end). Year 1: 100. Year 2: 100 * 1.1 + 100 = 210.
    res = api_client.post(
        "/api/calculator?ccy=EUR",
        json={
            "monthly": False,
            "expected_return_pct": "0.10",
            "band_pp": "0",
            "inflation_pct": "0",
            "contribution": "100",
            "horizon": 2,
            "target": "150",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert [Decimal(p["expected"]) for p in body["points"]] == [Decimal(100), Decimal("210.0")]
    assert Decimal(body["total_contributed"]) == Decimal(200)
    assert Decimal(body["final"]["projected_growth"]) == Decimal("10.0")
    assert body["hits"]["expected"]["label"].isdigit()
    assert body["hits"]["expected"]["years"] is not None
    assert body["assumptions"]["usd_per_eur"] is not None


def test_projection_validation(api_client: TestClient) -> None:
    assert api_client.post("/api/calculator", json={"horizon": -1}).status_code == 422
    assert api_client.post("/api/calculator?ccy=GBP", json={}).status_code == 422
