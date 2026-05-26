"""Tests for the v1.1 repo update helpers."""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import accounts_repo, instruments_repo


def test_update_account_changes_label_and_type(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Old label",
        native_currency="USD",
        account_type="brokerage",
    )
    updated = accounts_repo.update_account(
        session, acct.id, account_label="New label", account_type="savings"
    )
    assert updated.account_label == "New label"
    assert updated.account_type == "savings"
    # Immutable fields untouched.
    assert updated.broker == "fidelity"
    assert updated.native_currency == "USD"


def test_update_account_partial_keeps_other_fields(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Keep me",
        native_currency="USD",
        account_type="brokerage",
    )
    updated = accounts_repo.update_account(session, acct.id, account_type="cash")
    assert updated.account_label == "Keep me"
    assert updated.account_type == "cash"


def test_update_account_missing_raises(session: Session) -> None:
    with pytest.raises(ValueError, match="not found"):
        accounts_repo.update_account(session, 99999, account_label="x")


def test_update_instrument_changes_display_fields(session: Session) -> None:
    instr = instruments_repo.get_or_create(
        session, symbol="VTI", name="Old name", category="Old cat"
    )
    updated = instruments_repo.update_instrument(
        session,
        instr.id,
        name="Vanguard Total Market",
        category="US equities",
        active=False,
    )
    assert updated.name == "Vanguard Total Market"
    assert updated.category == "US equities"
    assert updated.active is False
    assert updated.symbol == "VTI"


def test_update_instrument_missing_raises(session: Session) -> None:
    with pytest.raises(ValueError, match="not found"):
        instruments_repo.update_instrument(session, 12345, name="x")


def test_update_account_can_toggle_active(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Toggle me",
        native_currency="USD",
        account_type="brokerage",
    )
    assert acct.active is True
    updated = accounts_repo.update_account(session, acct.id, active=False)
    assert updated.active is False
    re_enabled = accounts_repo.update_account(session, acct.id, active=True)
    assert re_enabled.active is True


def test_update_instrument_can_set_expense_ratio(session: Session) -> None:
    from decimal import Decimal

    instr = instruments_repo.get_or_create(session, symbol="VTI")
    assert instr.expense_ratio is None
    updated = instruments_repo.update_instrument(session, instr.id, expense_ratio=Decimal("0.0003"))
    assert updated.expense_ratio == Decimal("0.0003")
