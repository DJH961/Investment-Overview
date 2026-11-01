"""``/api/deposits`` route."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Account, Transaction, TransactionKind


def test_deposits_per_ccy(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    with ledger_session_scope() as s:
        acct = Account(
            broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
        )
        s.add(acct)
        s.flush()
        s.add(
            Transaction(
                account_id=acct.id,
                date=date(2025, 3, 10),
                kind=TransactionKind.DEPOSIT.value,
                net_native=Decimal(1000),
                net_eur=Decimal(800),
                net_usd=Decimal(1000),
                source="manual",
            )
        )
    eur = api_client.get("/api/deposits?ccy=EUR").json()
    usd = api_client.get("/api/deposits?ccy=USD").json()
    assert Decimal(eur["summary"]["total_contrib"]) == Decimal(800)
    assert Decimal(usd["summary"]["total_contrib"]) == Decimal(1000)
    assert Decimal(eur["rows"][0]["amount"]) == Decimal(800)
    assert Decimal(usd["rows"][0]["amount"]) == Decimal(1000)
    assert usd["rows"][0]["currency"] == "USD"


def test_deposits_account_filter(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    assert api_client.get("/api/deposits?account_id=999").json()["rows"] == []
    assert api_client.get("/api/deposits?account_id=0").status_code == 422
