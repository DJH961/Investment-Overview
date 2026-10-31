# ruff: noqa: PT018
"""API tests for ``/api/fx-conversions``."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Account, FxHistory, Transaction

BODY = {"date": "2024-01-15", "eur_sent": "1000", "usd_received": "1100", "fees_eur": "10"}


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/fx-conversions").status_code == 401


def test_crud(api_client: TestClient) -> None:
    created = api_client.post("/api/fx-conversions", json=BODY)
    assert created.status_code == 201
    row = created.json()
    assert Decimal(row["eur_sent"]) == 1000
    assert row["effective_rate"].startswith("1.1")
    assert api_client.get("/api/fx-conversions").json()[0]["id"] == row["id"]
    put = api_client.put(f"/api/fx-conversions/{row['id']}", json={**BODY, "note": "n"})
    assert put.status_code == 200 and put.json()["note"] == "n"
    assert api_client.delete(f"/api/fx-conversions/{row['id']}").status_code == 204
    assert api_client.delete(f"/api/fx-conversions/{row['id']}").status_code == 404
    assert api_client.put("/api/fx-conversions/99", json=BODY).status_code == 404


def test_validation(api_client: TestClient) -> None:
    assert api_client.post("/api/fx-conversions", json={**BODY, "eur_sent": "0"}).status_code == 422
    future = (date.today() + timedelta(days=2)).isoformat()
    assert api_client.post("/api/fx-conversions", json={**BODY, "date": future}).status_code == 422


def test_pool(api_client: TestClient) -> None:
    with ledger_session_scope() as s:
        acct = Account(broker="vanguard", account_label="V", native_currency="USD")
        s.add(acct)
        s.flush()
        s.add(FxHistory(date=date(2024, 1, 1), base="EUR", quote="USD", rate=Decimal("1.25")))
        s.add(
            Transaction(
                account_id=acct.id,
                date=date(2024, 2, 1),
                kind="deposit",
                net_native=Decimal("1500"),
                source="manual",
            )
        )
    api_client.post("/api/fx-conversions", json=BODY)
    pool = api_client.get("/api/fx-conversions/pool").json()
    assert len(pool["deposits"]) == 1
    dep = pool["deposits"][0]
    assert dep["fallback_to_ecb"] is True
    assert Decimal(dep["fallback_usd"]) == 400
    assert pool["fallbacks"] == [dep]
    assert Decimal(pool["balance_usd"]) == 0
