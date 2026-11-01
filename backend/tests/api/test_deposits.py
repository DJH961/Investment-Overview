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


def test_deposit_rows_show_conversion_batches_and_ecb_fallback(
    api_client: TestClient,
    api_db,  # type: ignore[no-untyped-def]
) -> None:
    from investment_dashboard.models.fx_conversion import FxConversion

    with ledger_session_scope() as s:
        acct = Account(
            broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
        )
        s.add(acct)
        s.flush()
        for d, usd in ((date(2025, 3, 10), 1000), (date(2025, 4, 10), 500)):
            s.add(
                Transaction(
                    account_id=acct.id,
                    date=d,
                    kind=TransactionKind.DEPOSIT.value,
                    net_native=Decimal(usd),
                    net_eur=Decimal(usd) * Decimal("0.8"),
                    net_usd=Decimal(usd),
                    source="manual",
                )
            )
        s.add(
            FxConversion(
                date=date(2025, 3, 1),
                eur_sent=Decimal(800),
                usd_received=Decimal(1000),
                fees_eur=None,
                note=None,
            )
        )
    rows = {r["date"]: r for r in api_client.get("/api/deposits?ccy=EUR").json()["rows"]}
    first, second = rows["2025-03-10"], rows["2025-04-10"]
    assert first["rate_source"] == "conversions"
    assert Decimal(first["effective_rate"]) == Decimal("1.25")
    assert [b["date"] for b in first["conversion_batches"]] == ["2025-03-01"]
    assert second["rate_source"] == "ecb"
    assert second["conversion_batches"] == []
    diag = api_client.get("/api/diagnostics").json()
    check = next(c for c in diag["checks"] if c["id"] == "ecb_fallback_deposits")
    assert check["count"] == 1
    assert check["severity"] == "warning"


def test_deposit_rows_without_conversions_claim_no_source(
    api_client: TestClient,
    api_db,  # type: ignore[no-untyped-def]
) -> None:
    assert api_client.get("/api/deposits").json()["rows"] == []
    check = next(
        c
        for c in api_client.get("/api/diagnostics").json()["checks"]
        if c["id"] == "ecb_fallback_deposits"
    )
    assert check["count"] == 0
    assert check["severity"] == "ok"
