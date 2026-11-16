"""``/api/periods`` routes."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from api._single import get_one
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Account, Transaction, TransactionKind
from investment_dashboard.repositories import fx_repo


@pytest.fixture
def seeded(api_db):  # type: ignore[no-untyped-def]
    with ledger_session_scope() as s:
        acct = Account(
            broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
        )
        s.add(acct)
        s.flush()
        # USD period columns need EUR->USD history (otherwise they are null).
        fx_repo.upsert_rates(s, {date(2025, 3, 10): Decimal("1.25")})
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


def test_monthly_eur_and_usd_contributions(api_client: TestClient, seeded) -> None:  # type: ignore[no-untyped-def]
    eur = get_one(api_client, "/api/periods/monthly?ccy=EUR")
    assert eur["ccy"] == "EUR"
    assert eur["granularity"] == "month"
    row = next(r for r in eur["rows"] if r["label"] == "2025-03")
    assert Decimal(row["contributions"]) == Decimal(800)

    usd = get_one(api_client, "/api/periods/monthly?ccy=USD")
    row = next(r for r in usd["rows"] if r["label"] == "2025-03")
    assert Decimal(row["contributions"]) == Decimal(1000)


def test_yearly_shape(api_client: TestClient, seeded) -> None:  # type: ignore[no-untyped-def]
    body = get_one(api_client, "/api/periods/yearly")
    assert body["granularity"] == "year"
    assert any(r["label"] == "2025" for r in body["rows"])
    assert {"total_growth_compounded", "period_growth_xirr", "is_current"} <= set(body["rows"][0])


def test_empty_db(api_client: TestClient) -> None:
    assert get_one(api_client, "/api/periods/yearly")["rows"] == []
