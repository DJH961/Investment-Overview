"""Tests for the ledger query helper used by ``/transactions``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo, instruments_repo
from investment_dashboard.ui.pages._ledger_query import (
    LedgerFilters,
    list_ledger_rows,
    summarize_ledger,
)


def _seed(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="VTI")
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=instr.id,
                quantity=Decimal("10"),
                price_native=Decimal("220.5"),
                net_native=Decimal("-2205.00"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 2, 1),
                kind="deposit",
                net_native=Decimal("1000.00"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_returns_newest_first(session: Session) -> None:
    _seed(session)
    rows = list_ledger_rows(session)
    assert [r["date"] for r in rows] == ["2024-02-01", "2024-01-05"]


def test_kind_filter(session: Session) -> None:
    _seed(session)
    rows = list_ledger_rows(session, LedgerFilters(kind="buy"))
    assert len(rows) == 1
    assert rows[0]["symbol"] == "VTI"
    assert rows[0]["net"] == "-2,205.00"


def test_symbol_filter(session: Session) -> None:
    _seed(session)
    rows = list_ledger_rows(session, LedgerFilters(instrument_symbol="VTI"))
    assert len(rows) == 1


def test_date_range_filter(session: Session) -> None:
    _seed(session)
    rows = list_ledger_rows(session, LedgerFilters(start=date(2024, 1, 15)))
    assert len(rows) == 1
    assert rows[0]["kind"] == "deposit"


def test_usd_native_uses_net_native_for_net_usd(session: Session) -> None:
    """USD-native rows must show the booked USD value, not a re-derived one."""
    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Vanguard",
        native_currency="USD",
        account_type="brokerage",
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 3, 1),
            kind="buy",
            net_native=Decimal("-19.99"),
            net_eur=Decimal("-17.24"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()
    rows = list_ledger_rows(session, fx_rate=Decimal("1.20"))
    assert rows[0]["net_usd"] == "-19.99"
    assert rows[0]["net_eur"] == "-17.24"


def test_eur_native_derives_only_net_usd(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Savings",
        native_currency="EUR",
        account_type="savings",
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 3, 1),
            kind="deposit",
            net_native=Decimal("100.00"),
            net_eur=Decimal("100.00"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()
    rows = list_ledger_rows(session, fx_rate=Decimal("1.10"))
    assert rows[0]["net_eur"] == "100.00"
    assert rows[0]["net_usd"] == "110.00"


def test_summarize_ledger_counts_and_average(session: Session) -> None:
    _seed(session)
    summary = summarize_ledger(session, fx_rate=Decimal("1.20"))
    # Two ledger rows total (one buy, one deposit).
    assert summary.count == 2
    assert summary.buy_count == 1
    assert summary.sell_count == 0
    # Average trade size only considers trade rows (the single buy);
    # the deposit is excluded. The USD-native buy carries no net_eur in
    # this seed, so the EUR average is 0 while USD uses net_native.
    assert summary.avg_trade_size_usd == Decimal("2205.00")


def test_net_eur_derived_from_trade_date_fx(session: Session) -> None:
    """A USD-native buy with no stored net_eur shows EUR at the trade-date rate.

    Regression for the v2.8 bug where the transactions table left Net EUR
    empty for every manually entered (USD) row.
    """
    from investment_dashboard.repositories import fx_repo

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    fx_repo.upsert_rates(session, {date(2024, 1, 5): Decimal("1.25")})
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 5),
            kind="buy",
            net_native=Decimal("-2500.00"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()
    # fx_rate (current spot) is only a fallback; the row has trade-date FX.
    rows = list_ledger_rows(session, fx_rate=Decimal("1.10"))
    row = rows[0]
    assert row["net_usd"] == "-2,500.00"
    # -2500 USD / 1.25 = -2000 EUR (trade-date rate, not the 1.10 fallback).
    assert row["net_eur"] == "-2,000.00"
