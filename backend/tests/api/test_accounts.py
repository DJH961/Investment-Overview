"""API tests for ``/api/accounts``, ``/api/instruments`` and ``/api/imports/brokers``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Transaction

BODY = {
    "account_label": "Main",
    "broker": "fidelity",
    "native_currency": "usd",
    "account_type": "brokerage",
}


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/accounts").status_code == 401
    assert anon_client.get("/api/imports/brokers").status_code == 401


def test_crud(api_client: TestClient) -> None:
    created = api_client.post("/api/accounts", json=BODY)
    assert created.status_code == 201
    row = created.json()
    assert row["native_currency"] == "USD"
    assert row["transaction_count"] == 0
    assert any(a["id"] == row["id"] for a in api_client.get("/api/accounts").json())
    put = api_client.put(
        f"/api/accounts/{row['id']}",
        json={**BODY, "account_label": "Renamed", "broker": "vanguard"},
    )
    assert put.status_code == 200
    assert put.json()["account_label"] == "Renamed"
    assert put.json()["broker"] == "vanguard"
    assert api_client.delete(f"/api/accounts/{row['id']}").status_code == 204
    assert api_client.delete(f"/api/accounts/{row['id']}").status_code == 404
    assert api_client.put("/api/accounts/9999", json=BODY).status_code == 404


def test_validation(api_client: TestClient) -> None:
    assert api_client.post("/api/accounts", json={**BODY, "broker": "nope"}).status_code == 422


def test_account_with_transactions_is_protected(api_client: TestClient) -> None:
    acct = api_client.post("/api/accounts", json=BODY).json()
    with ledger_session_scope() as s:
        s.add(
            Transaction(
                account_id=acct["id"],
                date=date(2024, 1, 1),
                kind="deposit",
                net_native=Decimal("10"),
                source="manual",
            )
        )
    assert api_client.delete(f"/api/accounts/{acct['id']}").status_code == 409
    moved = api_client.put(f"/api/accounts/{acct['id']}", json={**BODY, "broker": "vanguard"})
    assert moved.status_code == 409
    renamed = api_client.put(f"/api/accounts/{acct['id']}", json={**BODY, "account_label": "X"})
    assert renamed.status_code == 200


def test_instruments_list(api_client: TestClient) -> None:
    assert api_client.get("/api/instruments").status_code == 200


def test_import_brokers(api_client: TestClient) -> None:
    rows = api_client.get("/api/imports/brokers").json()
    ids = {r["id"] for r in rows}
    assert {"fidelity", "vanguard"} <= ids
    assert all(".csv" in r["file_types"] and r["label"] for r in rows)
