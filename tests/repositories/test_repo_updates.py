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
    from investment_dashboard.repositories import instrument_overrides_repo

    instr = instruments_repo.get_or_create(session, symbol="VTI", name="Old name")
    instrument_overrides_repo.set_category(session, instr.id, "Old cat")
    updated = instruments_repo.update_instrument(
        session,
        instr.id,
        name="Vanguard Total Market",
    )
    # Category and active live on the override now.
    instrument_overrides_repo.upsert(session, instr.id, category="US equities", active=False)
    assert updated.name == "Vanguard Total Market"
    assert instrument_overrides_repo.get_category(session, instr.id) == "US equities"
    assert instrument_overrides_repo.is_active(session, instr.id) is False
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


def test_update_instrument_can_change_symbol_and_currency(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="DAX", native_currency="USD")
    updated = instruments_repo.update_instrument(
        session, instr.id, symbol="exs1.de", native_currency="eur"
    )
    # Symbol and currency are normalised to upper-case.
    assert updated.symbol == "EXS1.DE"
    assert updated.native_currency == "EUR"
    assert instruments_repo.get_by_symbol(session, "EXS1.DE") is not None


def test_update_instrument_rejects_duplicate_symbol(session: Session) -> None:
    import pytest

    instruments_repo.get_or_create(session, symbol="VTI")
    other = instruments_repo.get_or_create(session, symbol="VOO")
    with pytest.raises(ValueError, match="already uses symbol"):
        instruments_repo.update_instrument(session, other.id, symbol="VTI")


def test_update_instrument_rejects_blank_symbol_and_bad_currency(session: Session) -> None:
    import pytest

    instr = instruments_repo.get_or_create(session, symbol="VTI")
    with pytest.raises(ValueError, match="blank"):
        instruments_repo.update_instrument(session, instr.id, symbol="   ")
    with pytest.raises(ValueError, match="3-letter"):
        instruments_repo.update_instrument(session, instr.id, native_currency="US")


def test_update_instrument_clear_expense_ratio(session: Session) -> None:
    from decimal import Decimal

    instr = instruments_repo.get_or_create(session, symbol="VTI", expense_ratio=Decimal("0.0003"))
    updated = instruments_repo.update_instrument(session, instr.id, clear_expense_ratio=True)
    assert updated.expense_ratio is None


def test_update_instrument_same_symbol_is_noop(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI")
    updated = instruments_repo.update_instrument(session, instr.id, symbol="vti", name="New")
    assert updated.symbol == "VTI"
    assert updated.name == "New"
