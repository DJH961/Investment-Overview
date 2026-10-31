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
    assert rows[0]["net"] == "$-2,205.00"


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
    assert rows[0]["net_usd"] == "$-19.99"
    assert rows[0]["net_eur"] == "€-17.24"


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
    assert rows[0]["net_eur"] == "€100.00"
    assert rows[0]["net_usd"] == "$110.00"


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
    assert row["net_usd"] == "$-2,500.00"
    # -2500 USD / 1.25 = -2000 EUR (trade-date rate, not the 1.10 fallback).
    assert row["net_eur"] == "€-2,000.00"


def test_money_market_reinvested_dividend_values_the_payout(session: Session) -> None:
    """A VMFXX par-$1 reinvested dividend shows its payout, not €0.00 / $0.00.

    Regression for the Activity-tab bug where a money-market dividend booked as
    a cash-neutral ``dividend_reinvest`` (``net_native == 0``) rendered as 0 in
    both currencies. The dividend's real value is its reinvested amount
    (``quantity × price`` at the $1.00 NAV), valued at the trade-date FX rate.
    """
    from investment_dashboard.repositories import fx_repo

    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Vanguard",
        native_currency="USD",
        account_type="brokerage",
    )
    vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX")
    fx_repo.upsert_rates(session, {date(2024, 3, 31): Decimal("1.25")})
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 3, 31),
            kind="dividend_reinvest",
            instrument_id=vmfxx.id,
            quantity=Decimal("12.50"),
            price_native=Decimal("1"),
            net_native=Decimal("0"),
            source=TransactionSource.IMPORT_VANGUARD_XLSX,
            external_id="div-1",
        )
    )
    session.flush()
    rows = list_ledger_rows(session, fx_rate=Decimal("1.10"))
    row = rows[0]
    # USD payout is the reinvested amount; EUR at the trade-date rate (÷1.25).
    assert row["net_usd"] == "$12.50"
    assert row["net_eur"] == "€10.00"


def test_normal_reinvested_dividend_keeps_its_cash_flow(session: Session) -> None:
    """A real (non money-market) reinvestment is untouched by the MM special case."""
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="VWCE")
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 3, 31),
            kind="dividend_reinvest",
            instrument_id=instr.id,
            quantity=Decimal("0.42"),
            price_native=Decimal("120.50"),
            net_native=Decimal("-50.61"),
            net_eur=Decimal("-46.00"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()
    rows = list_ledger_rows(session, fx_rate=Decimal("1.10"))
    row = rows[0]
    assert row["net_usd"] == "$-50.61"
    assert row["net_eur"] == "€-46.00"


def _seed_with_settlement_leg(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Vanguard",
        native_currency="USD",
        account_type="brokerage",
    )
    vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX")
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="deposit",
                net_native=Decimal("1000.00"),
                source=TransactionSource.IMPORT_VANGUARD_XLSX,
                external_id="dep-1",
            ),
            # Auto-generated settlement leg paired to the deposit.
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=vmfxx.id,
                quantity=Decimal("1000.00"),
                price_native=Decimal("1"),
                net_native=Decimal("-1000.00"),
                source=TransactionSource.IMPORT_VANGUARD_XLSX,
                external_id="dep-1:vmfxx",
            ),
        ]
    )
    session.flush()


def test_settlement_sweeps_hidden_by_default(session: Session) -> None:
    _seed_with_settlement_leg(session)
    rows = list_ledger_rows(session)
    # The :vmfxx settlement leg is hidden; the genuine deposit remains.
    assert len(rows) == 1
    assert rows[0]["kind"] == "deposit"


def test_settlement_sweeps_shown_when_requested(session: Session) -> None:
    _seed_with_settlement_leg(session)
    rows = list_ledger_rows(session, LedgerFilters(hide_settlement_sweeps=False))
    assert len(rows) == 2
    assert any(r["symbol"] == "VMFXX" for r in rows)


def test_summary_excludes_hidden_sweeps(session: Session) -> None:
    _seed_with_settlement_leg(session)
    summary = summarize_ledger(session)
    # Only the deposit is counted; the hidden VMFXX buy leg is excluded.
    assert summary.count == 1
    assert summary.buy_count == 0
