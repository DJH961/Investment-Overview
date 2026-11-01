"""``/api/analytics`` route."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )


def test_analytics_empty_db_is_all_null_not_error(api_client: TestClient) -> None:
    res = api_client.get("/api/analytics?lookback_days=7")
    assert res.status_code == 200
    body = res.json()
    assert body["ccy"] == "EUR"
    assert body["cagr"] is None
    assert body["attribution"] == []
    assert body["attribution_currency"] == "EUR"


def test_analytics_usd_attribution_is_in_usd(api_client: TestClient) -> None:
    body = api_client.get("/api/analytics?ccy=USD&lookback_days=7").json()
    assert body["ccy"] == "USD"
    assert body["currency"] == "USD"
    assert body["attribution"] == []
    assert body["attribution_currency"] == "USD"


def test_analytics_validates_params(api_client: TestClient) -> None:
    assert api_client.get("/api/analytics?lookback_days=0").status_code == 422
    assert api_client.get("/api/analytics?ccy=XXX").status_code == 422
