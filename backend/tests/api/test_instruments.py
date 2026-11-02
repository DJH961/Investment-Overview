"""``/api/instruments``: list and edit instrument overrides."""

from __future__ import annotations

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import instruments_repo


def _seed() -> tuple[int, int]:
    with ledger_session_scope() as s:
        a = instruments_repo.get_or_create(s, symbol="AAA.B", name="Fund A", asset_class="etf")
        b = instruments_repo.get_or_create(s, symbol="BBB", asset_class="stock")
        return a.id, b.id


def test_list_and_edit(api_client: TestClient) -> None:
    a, _b = _seed()
    rows = {r["id"]: r for r in api_client.get("/api/instruments").json()}
    assert rows[a]["fetch_symbol"] == "AAA.B"
    assert rows[a]["pricing_mode"] == "auto"
    assert rows[a]["native_currency"] == "USD"

    resp = api_client.patch(
        f"/api/instruments/{a}",
        json={"name": "Nice name", "provider_symbol": "aaa-b", "expense_ratio": "0.0003"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert sorted(body["changed"]) == ["expense_ratio", "name", "provider_symbol"]
    assert body["redownload_suggested"] is True
    got = body["instrument"]
    assert got["name"] == "Nice name"
    assert got["ledger_name"] == "Fund A"
    assert got["fetch_symbol"] == "AAA-B"
    assert got["expense_ratio"] == "0.00030"

    frozen = api_client.patch(f"/api/instruments/{a}", json={"pricing_mode": "delisted"}).json()
    assert frozen["instrument"]["fetch_symbol"] is None
    assert frozen["redownload_suggested"] is False

    cleared = api_client.patch(f"/api/instruments/{a}", json={"name": None}).json()
    assert cleared["instrument"]["name"] == "Fund A"
    unchanged = api_client.patch(f"/api/instruments/{a}", json={"name": None}).json()
    assert unchanged["changed"] == []


def test_validation_is_all_or_nothing(api_client: TestClient) -> None:
    a, _b = _seed()
    resp = api_client.patch(
        f"/api/instruments/{a}",
        json={"name": "ok", "provider_symbol": "BBB", "expense_ratio": "5"},
    )
    assert resp.status_code == 422
    errors = resp.json()["errors"]
    assert set(errors) == {"provider_symbol", "expense_ratio"}
    assert api_client.get(f"/api/instruments/{a}").json()["name"] == "Fund A"
    assert api_client.patch(f"/api/instruments/{a}", json={"pricing_mode": "x"}).status_code == 422
    assert api_client.patch("/api/instruments/9999", json={"name": "x"}).status_code == 404
