"""``/api/transactions``: list/detail + manual create / edit / delete."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo, fx_repo, instruments_repo


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


def _buy(account_id: int, **over: object) -> dict[str, object]:
    body: dict[str, object] = {
        "account_id": account_id,
        "date": "2024-01-05",
        "kind": "buy",
        "symbol": "vti",
        "quantity": "2",
        "price": "100",
        "fees": "1",
    }
    body.update(over)
    return body


def test_create_buy_applies_signs_and_freezes_legs(api_client: TestClient, account_id: int) -> None:
    resp = api_client.post("/api/transactions", json=_buy(account_id))
    assert resp.status_code == 201, resp.text
    txn = resp.json()["transaction"]
    assert txn["symbol"] == "VTI"
    assert Decimal(txn["quantity"]) == Decimal("2")
    assert Decimal(txn["gross_native"]) == Decimal("200")
    assert Decimal(txn["net_native"]) == Decimal("-201")
    assert Decimal(txn["net_usd"]) == Decimal("-201")
    assert txn["net_eur"] is not None
    assert txn["source"] == "manual"
    assert resp.json()["warnings"] == []


def test_sell_has_negative_quantity_and_positive_net(
    api_client: TestClient, account_id: int
) -> None:
    resp = api_client.post(
        "/api/transactions", json=_buy(account_id, kind="sell", quantity=None, price=None)
    )
    assert resp.status_code == 422  # not enough figures to reconcile
    resp = api_client.post("/api/transactions", json=_buy(account_id, kind="sell"))
    txn = resp.json()["transaction"]
    assert Decimal(txn["quantity"]) == Decimal("-2")
    assert Decimal(txn["net_native"]) == Decimal("199")


def test_validation_errors(api_client: TestClient, account_id: int) -> None:
    post = api_client.post
    assert post("/api/transactions", json=_buy(999)).status_code == 422
    assert post("/api/transactions", json=_buy(account_id, kind="nope")).status_code == 422
    assert post("/api/transactions", json=_buy(account_id, symbol=None)).status_code == 422
    bad = post("/api/transactions", json=_buy(account_id, total="5000"))
    assert bad.status_code == 422
    assert "match" in str(bad.json()["detail"])
    assert post("/api/transactions", json=_buy(account_id, quantity="-1")).status_code == 422
    cash = post(
        "/api/transactions",
        json={"account_id": account_id, "date": "2024-01-05", "kind": "deposit"},
    )
    assert cash.status_code == 422


def test_missing_fx_adds_warning(api_client: TestClient, account_id: int) -> None:
    resp = api_client.post("/api/transactions", json=_buy(account_id, date="2020-01-02"))
    assert resp.status_code == 201
    assert resp.json()["warnings"]


def test_list_filters_paging_and_detail(api_client: TestClient, account_id: int) -> None:
    for day in ("2024-01-05", "2024-01-06", "2024-01-07"):
        api_client.post("/api/transactions", json=_buy(account_id, date=day))
    api_client.post(
        "/api/transactions",
        json={"account_id": account_id, "date": "2024-01-08", "kind": "deposit", "total": "1000"},
    )
    page = api_client.get("/api/transactions", params={"limit": 2}).json()
    assert page["total"] == 4
    assert len(page["rows"]) == 2
    assert page["rows"][0]["date"] == "2024-01-08"  # newest first
    assert page["summary"]["count"] == 4
    assert page["summary"]["buy_count"] == 3
    rest = api_client.get("/api/transactions", params={"limit": 2, "offset": 2}).json()
    assert [r["date"] for r in rest["rows"]] == ["2024-01-06", "2024-01-05"]

    assert api_client.get("/api/transactions", params={"kind": "deposit"}).json()["total"] == 1
    assert api_client.get("/api/transactions", params={"symbol": "vti"}).json()["total"] == 3
    ranged = api_client.get(
        "/api/transactions", params={"start": "2024-01-06", "end": "2024-01-07"}
    ).json()
    assert ranged["total"] == 2
    assert api_client.get("/api/transactions", params={"q": "fidel"}).json()["total"] == 4
    assert api_client.get("/api/transactions", params={"q": "zzz"}).json()["total"] == 0
    assert api_client.get("/api/transactions", params={"limit": 0}).status_code == 422

    one = api_client.get(f"/api/transactions/{page['rows'][0]['id']}")
    assert one.status_code == 200
    assert one.json()["kind"] == "deposit"
    assert api_client.get("/api/transactions/9999").status_code == 404


def test_update_and_delete(api_client: TestClient, account_id: int) -> None:
    created = api_client.post("/api/transactions", json=_buy(account_id)).json()["transaction"]
    tid = created["id"]
    resp = api_client.put(
        f"/api/transactions/{tid}", json=_buy(account_id, quantity="3", price="100", fees="0")
    )
    assert resp.status_code == 200, resp.text
    assert Decimal(resp.json()["transaction"]["net_native"]) == Decimal("-300")
    assert api_client.put("/api/transactions/9999", json=_buy(account_id)).status_code == 404

    assert api_client.delete(f"/api/transactions/{tid}").status_code == 200
    assert api_client.delete(f"/api/transactions/{tid}").status_code == 404
    assert api_client.get(f"/api/transactions/{tid}").status_code == 404


def test_imported_rows_are_editable_like_v5(api_client: TestClient, account_id: int) -> None:
    with ledger_session_scope() as s:
        vti = instruments_repo.get_or_create(s, symbol="VTI")
        txn = Transaction(
            account_id=account_id,
            instrument_id=vti.id,
            date=date(2024, 1, 5),
            kind="buy",
            quantity=Decimal("1"),
            price_native=Decimal("10"),
            net_native=Decimal("-10"),
            external_id="abc",
            source=TransactionSource.IMPORT_FIDELITY_CSV,
        )
        s.add(txn)
        s.flush()
        tid = txn.id
    resp = api_client.put(
        f"/api/transactions/{tid}", json=_buy(account_id, quantity="1", price="12", fees="0")
    )
    assert resp.status_code == 200
    assert resp.json()["transaction"]["source"] == "import_fidelity_csv"


def test_money_market_leg_is_created_edited_and_deleted(
    api_client: TestClient, account_id: int
) -> None:
    with ledger_session_scope() as s:
        vmfxx = instruments_repo.get_or_create(s, symbol="VMFXX")
        s.add(
            Transaction(
                account_id=account_id,
                instrument_id=vmfxx.id,
                date=date(2023, 1, 1),
                kind="buy",
                net_native=Decimal("-1"),
                source=TransactionSource.MANUAL,
            )
        )
    body = {
        "account_id": account_id,
        "date": "2024-01-05",
        "kind": "deposit",
        "total": "1000",
        "route_money_market": True,
    }
    created = api_client.post("/api/transactions", json=body).json()
    assert created["warnings"] == []
    tid = created["transaction"]["id"]

    def sweeps() -> list[dict[str, object]]:
        rows = api_client.get(
            "/api/transactions", params={"hide_sweeps": "false", "symbol": "VMFXX"}
        ).json()["rows"]
        return [r for r in rows if r["is_settlement_leg"]]

    assert len(sweeps()) == 1
    assert Decimal(str(sweeps()[0]["net_native"])) == Decimal("-1000")

    api_client.put(f"/api/transactions/{tid}", json={**body, "total": "1500"})
    assert Decimal(str(sweeps()[0]["net_native"])) == Decimal("-1500")

    api_client.delete(f"/api/transactions/{tid}")
    assert sweeps() == []


def test_money_market_without_fund_warns(api_client: TestClient, account_id: int) -> None:
    resp = api_client.post(
        "/api/transactions",
        json={
            "account_id": account_id,
            "date": "2024-01-05",
            "kind": "deposit",
            "total": "100",
            "route_money_market": True,
        },
    )
    assert resp.status_code == 201
    assert any("money-market" in w for w in resp.json()["warnings"])


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/transactions").status_code == 401
