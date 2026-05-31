"""Tests for the deposits query helpers (summary + table rows)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.ui.pages._deposits_query import (
    compute_summary,
    list_deposit_rows,
)


def _seed(session: Session) -> int:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    today = date.today()
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2023, 6, 1),
                kind="deposit",
                net_native=Decimal("500.00"),
                net_eur=Decimal("450.00"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(today.year, 1, 10),
                kind="deposit",
                net_native=Decimal("1000.00"),
                net_eur=Decimal("900.00"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=today,
                kind="deposit",
                net_native=Decimal("200.00"),
                net_eur=Decimal("180.00"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(today.year, 1, 15),
                kind="interest",
                net_native=Decimal("12.00"),
                net_eur=Decimal("11.00"),
                source=TransactionSource.MANUAL,
            ),
            # Non-deposit kinds must be excluded.
            Transaction(
                account_id=acct.id,
                date=today,
                kind="buy",
                quantity=Decimal("1"),
                price_native=Decimal("10"),
                net_native=Decimal("-10"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()
    return acct.id


def test_only_cashflow_kinds_in_table(session: Session) -> None:
    _seed(session)
    rows = list_deposit_rows(session)
    kinds = {r["kind"] for r in rows}
    assert kinds == {"deposit"}


def test_summary_totals(session: Session) -> None:
    _seed(session)
    today = date.today()
    summary = compute_summary(session, today=today)
    # 450 + 900 + 180 = 1530 (3 deposits, no withdrawals)
    assert summary.total_contrib_eur == Decimal("1530.00")
    # YTD deposits = 900 + 180 = 1080
    assert summary.ytd_contrib_eur == Decimal("1080.00")
    # MTD = today's only = 180
    assert summary.mtd_contrib_eur == Decimal("180.00")
    # Seed account is USD-native, so the USD totals come straight from
    # net_native (no EUR round-trip) regardless of whether FX history
    # was seeded — verifies the v2.4 fix for the deposits-USD column.
    assert summary.total_contrib_usd == Decimal("1700.00")  # 500+1000+200
    assert summary.ytd_contrib_usd == Decimal("1200.00")  # 1000+200
    assert summary.mtd_contrib_usd == Decimal("200.00")  # today's


def test_summary_handles_no_data(session: Session) -> None:
    summary = compute_summary(session)
    assert summary.total_contrib_eur == Decimal(0)
    assert summary.ytd_contrib_eur == Decimal(0)
    assert summary.total_contrib_usd == Decimal(0)
    assert summary.ytd_contrib_usd == Decimal(0)


def test_eur_computed_from_trade_date_fx_not_parity(session: Session) -> None:
    """A USD deposit with no stored net_eur must convert at the trade-date rate.

    Regression for the v2.8 bug where USD and EUR sat at parity because the
    EUR leg fell back to ``net_native`` whenever ``net_eur`` was empty (which
    is the case for every manually entered transaction).
    """
    from investment_dashboard.repositories import fx_repo

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    fx_repo.upsert_rates(session, {date(2024, 6, 3): Decimal("1.25")})
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 6, 3),
            kind="deposit",
            net_native=Decimal("1000.00"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()
    rows = list_deposit_rows(session)
    assert rows[0]["amount_usd"] == "$1,000.00"
    # 1000 USD / 1.25 (USD per EUR) = 800 EUR — explicitly *not* 1000.
    assert rows[0]["amount_eur"] == "€800.00"

    summary = compute_summary(session, today=date(2024, 6, 4))
    assert summary.total_contrib_usd == Decimal("1000.00")
    assert summary.total_contrib_eur == Decimal("800.00")


def test_eur_native_missing_trade_date_fx_uses_current_fallback(session: Session) -> None:
    """Keep deposits consistent with the ledger fallback for sparse FX history."""
    from investment_dashboard.repositories import fx_repo

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="EUR account",
        native_currency="EUR",
        account_type="brokerage",
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 1),
            kind="deposit",
            net_native=Decimal("100.00"),
            net_eur=Decimal("100.00"),
            source=TransactionSource.MANUAL,
        )
    )
    fx_repo.upsert_rates(session, {date(2024, 6, 1): Decimal("1.20")})
    session.flush()

    summary = compute_summary(session, today=date(2024, 6, 2))

    assert summary.total_contrib_eur == Decimal("100.00")
    assert summary.total_contrib_usd == Decimal("120.0000")
