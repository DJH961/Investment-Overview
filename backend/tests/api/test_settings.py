"""``/api/settings``: typed read and partial update."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_defaults_and_options(api_client: TestClient) -> None:
    data = api_client.get("/api/settings").json()
    assert data["display_ccy"] in ("EUR", "USD")
    assert data["theme"] == "auto"
    assert data["clock_format"] == "auto"
    assert data["auto_refresh_seconds"] == 60
    assert data["onboarded"] is False
    assert "Europe/Berlin" in data["options"]["timezones"]
    assert data["options"]["auto_refresh_min_seconds"] == 15
    assert isinstance(data["investment_amount_eur"], str)
    assert data["chart_prefs"]["overview_value_range"] == "Year"


def test_partial_update_round_trips(api_client: TestClient) -> None:
    resp = api_client.put(
        "/api/settings",
        json={
            "display_ccy": "USD",
            "theme": "dark",
            "timezone": "Europe/Berlin",
            "clock_format": "24h",
            "auto_refresh_seconds": 120,
            "investment_amount_eur": "750.5",
            "chart_prefs": {"overview_value_range": "Month", "calc.rebalance": "1"},
        },
    )
    assert resp.status_code == 200, resp.text
    again = api_client.get("/api/settings").json()
    assert again["display_ccy"] == "USD"
    assert again["theme"] == "dark"
    assert again["timezone"] == "Europe/Berlin"
    assert again["clock_format"] == "24h"
    assert again["auto_refresh_seconds"] == 120
    assert again["investment_amount_eur"] == "750.50"
    assert again["chart_prefs"]["overview_value_range"] == "Month"
    assert again["chart_prefs"]["calc.rebalance"] == "1"

    # Untouched fields stay as they were.
    api_client.put("/api/settings", json={"theme": "light"})
    kept = api_client.get("/api/settings").json()
    assert kept["theme"] == "light"
    assert kept["display_ccy"] == "USD"


def test_invalid_values_are_rejected(api_client: TestClient) -> None:
    put = api_client.put
    assert put("/api/settings", json={"display_ccy": "GBP"}).status_code == 422
    assert put("/api/settings", json={"theme": "blue"}).status_code == 422
    assert put("/api/settings", json={"clock_format": "7h"}).status_code == 422
    assert put("/api/settings", json={"auto_refresh_seconds": 5}).status_code == 422
    assert put("/api/settings", json={"timezone": "Mars/Base"}).status_code == 422
    assert put("/api/settings", json={"investment_amount_eur": "-3"}).status_code == 422
    assert put("/api/settings", json={"chart_prefs": {"nope": "1"}}).status_code == 422
    assert put("/api/settings", json={"chart_prefs": {"calc.rebalance": "7"}}).status_code == 422
    assert put("/api/settings", json={"surprise": 1}).status_code == 422
    # A rejected request leaves nothing half-applied.
    assert api_client.get("/api/settings").json()["theme"] == "auto"


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/settings").status_code == 401
