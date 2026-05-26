"""Tests for the period (monthly/yearly) aggregation helper."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.ui.pages._period_query import aggregate


def _seed(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 15),
                kind="deposit",
                net_eur=Decimal("500"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 20),
                kind="dividend_cash",
                net_eur=Decimal("12"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 2, 1),
                kind="deposit",
                net_eur=Decimal("300"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2025, 3, 1),
                kind="interest",
                net_eur=Decimal("8"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_monthly_buckets(session: Session) -> None:
    _seed(session)
    rows = aggregate(session, monthly=True)
    labels = [r.label for r in rows]
    assert labels == ["2024-01", "2024-02", "2025-03"]
    jan = rows[0]
    assert jan.contributions == Decimal("500")
    assert jan.dividends == Decimal("12")
    assert jan.net_flow == Decimal("512")


def test_yearly_buckets(session: Session) -> None:
    _seed(session)
    rows = aggregate(session, monthly=False)
    assert [r.label for r in rows] == ["2024", "2025"]
    assert rows[0].contributions == Decimal("800")
    assert rows[1].interest == Decimal("8")
