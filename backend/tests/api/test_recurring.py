# ruff: noqa: PT018
"""API tests for ``/api/recurring``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient

from investment_dashboard.api.activity import subject_for
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Account, FxHistory, Instrument, Transaction

CONVERSION = {
    "kind": "conversion",
    "unit": "months",
    "every": 1,
    "anchor": 10,
    "start_date": "2026-02-01",
    "end_date": "2026-02-28",
    "amount": "500",
    "provider": "wise",
    "expected_fee": "2",
}


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/recurring/plans").status_code == 401
    assert anon_client.get("/api/recurring/estimates").status_code == 401


def test_plan_lifecycle(api_client: TestClient) -> None:
    created = api_client.post("/api/recurring/plans", json=CONVERSION)
    assert created.status_code == 201
    plan = created.json()
    assert plan["provider"] == "wise" and plan["expected_fee"] == "2.000000"
    assert plan["status"] in {"active", "ended"}
    pid = plan["id"]
    put = api_client.put(f"/api/recurring/plans/{pid}", json={**CONVERSION, "amount": "600"})
    assert put.status_code == 200 and put.json()["amount"] == "600.000000"
    assert api_client.post(f"/api/recurring/plans/{pid}/pause").json()["status"] == "paused"
    assert api_client.post(f"/api/recurring/plans/{pid}/resume").json()["paused"] is False
    assert api_client.post(f"/api/recurring/plans/{pid}/end").status_code == 200
    assert [p["id"] for p in api_client.get("/api/recurring/plans").json()] == [pid]
    assert api_client.delete(f"/api/recurring/plans/{pid}").status_code == 204
    assert api_client.delete(f"/api/recurring/plans/{pid}").status_code == 404


def test_validation(api_client: TestClient) -> None:
    assert (
        api_client.post("/api/recurring/plans", json={**CONVERSION, "provider": "nope"}).status_code
        == 422
    )
    assert (
        api_client.post("/api/recurring/plans", json={**CONVERSION, "every": 0}).status_code == 422
    )
    assert (
        api_client.post(
            "/api/recurring/plans", json={**CONVERSION, "end_date": "2025-01-01"}
        ).status_code
        == 422
    )


def test_estimates_and_settle(api_client: TestClient) -> None:
    with ledger_session_scope() as s:
        acct = Account(broker="vanguard", account_label="V", native_currency="USD")
        s.add(acct)
        s.add(FxHistory(date=date(2026, 2, 10), base="EUR", quote="USD", rate=Decimal("1.2")))
        s.add(Instrument(symbol="VOO", name="Fund", asset_class="etf", native_currency="USD"))
        s.flush()
        s.add(
            Transaction(
                account_id=acct.id,
                date=date(2026, 2, 10),
                kind="deposit",
                net_native=Decimal("100"),
                source="manual",
            )
        )
    plan = api_client.post("/api/recurring/plans", json=CONVERSION).json()
    from investment_dashboard.services import recurring_service

    with ledger_session_scope() as s:
        assert recurring_service.generate_due_estimates(s, today=date(2026, 2, 12)).created == 1
    est = api_client.get("/api/recurring/estimates").json()
    assert est["count"] == 1
    (row,) = est["rows"]
    assert row["row_type"] == "fx_conversion" and row["plan_id"] == plan["id"]
    assert Decimal(row["received"]) == Decimal("600")  # plain ECB: no past conversion
    conversions = api_client.get("/api/fx-conversions").json()
    assert conversions[0]["is_estimate"] is True
    done = api_client.post(
        "/api/recurring/settle",
        json={"rows": [{"row_type": "fx_conversion", "id": row["id"], "received": "598.5"}]},
    )
    assert done.json() == {"settled": 1, "remaining": 0}
    assert api_client.get("/api/fx-conversions").json()[0]["is_estimate"] is False
    bad = api_client.post(
        "/api/recurring/settle", json={"rows": [{"row_type": "fx_conversion", "id": row["id"]}]}
    )
    assert bad.status_code == 422


def test_writes_are_logged_under_changes() -> None:
    assert subject_for("POST", "/api/recurring/settle") == "changes"
    assert subject_for("PUT", "/api/recurring/plans/3") == "changes"
