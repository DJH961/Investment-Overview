"""``GET /api/transactions/all``: the whole ledger for client-side lists."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import accounts_repo, fx_repo


@pytest.fixture
def account_id(api_db: object) -> int:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Fidelity",
            native_currency="USD",
            account_type="brokerage",
        )
        fx_repo.upsert_rates(s, {date(2024, 1, 5): Decimal("1.10")})
        return acct.id


def _buy(account_id: int, day: str) -> dict[str, object]:
    return {
        "account_id": account_id,
        "date": day,
        "kind": "buy",
        "symbol": "VTI",
        "quantity": "2",
        "price": "100",
        "fees": "1",
    }


def test_all_returns_every_row_newest_first(api_client: TestClient, account_id: int) -> None:
    for day in ("2024-01-05", "2024-01-06"):
        assert api_client.post("/api/transactions", json=_buy(account_id, day)).status_code == 201
    resp = api_client.get("/api/transactions/all")
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert [r["date"] for r in rows][:2] == ["2024-01-06", "2024-01-05"]
    assert {"id", "symbol", "account", "kind", "net_native", "currency", "cash_eur"} <= rows[
        0
    ].keys()
    assert "etag" in resp.headers


def test_all_etag_304_and_write_invalidates(api_client: TestClient, account_id: int) -> None:
    api_client.post("/api/transactions", json=_buy(account_id, "2024-01-05"))
    first = api_client.get("/api/transactions/all")
    etag = first.headers["etag"]
    again = api_client.get("/api/transactions/all", headers={"If-None-Match": etag})
    assert again.status_code == 304
    api_client.post("/api/transactions", json=_buy(account_id, "2024-01-06"))
    after = api_client.get("/api/transactions/all", headers={"If-None-Match": etag})
    assert after.status_code == 200
    assert len(after.json()["rows"]) == len(first.json()["rows"]) + 1
    assert after.headers["etag"] != etag
