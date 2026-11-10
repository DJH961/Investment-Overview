"""B-021: ledger and conversion edits leave a ``changes`` line (ids, never amounts)."""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import accounts_repo, fx_repo
from investment_dashboard.services import fx_conversion_service as conversions
from investment_dashboard.services import transaction_edit_service as svc
from investment_dashboard.services.transaction_edit_service import TransactionInput

D = Decimal


def _lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "activity.changes"]


def test_transaction_create_update_delete_are_logged_without_amounts(
    session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    fx_repo.upsert_rates(session, {date(2024, 1, 5): D("1.25")})
    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="V",
        native_currency="USD",
        account_type="brokerage",
    )
    data = TransactionInput(
        account_id=acct.id, date=date(2024, 1, 5), kind="deposit", total=D("98765.43")
    )
    with caplog.at_level(logging.INFO, logger="activity.changes"):
        created = svc.create(session, data)
        svc.update(session, created.transaction.id, data)
        assert svc.delete(session, created.transaction.id) is True
    lines = _lines(caplog)
    tid = created.transaction.id
    prefix = f"id={tid} date=2024-01-05 kind=deposit account_id={acct.id}"
    assert lines == [
        f"transaction created: {prefix}",
        f"transaction updated: {prefix}",
        f"transaction deleted: {prefix}",
    ]
    assert not any("98765" in line for line in lines)


def test_conversion_create_update_delete_are_logged_without_amounts(
    session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="activity.changes"):
        row = conversions.create_conversion(
            session, on=date(2024, 1, 10), eur_sent=D("12345"), usd_received=D("15432")
        )
        conversions.update_conversion(
            session, row.id, on=date(2024, 1, 11), eur_sent=D("12345"), usd_received=D("15432")
        )
        assert conversions.delete_conversion(session, row.id) is True
        assert conversions.delete_conversion(session, row.id) is False  # nothing to log
    lines = _lines(caplog)
    assert lines == [
        f"conversion created: id={row.id} date=2024-01-10 kind=fx_conversion",
        f"conversion updated: id={row.id} date=2024-01-11 kind=fx_conversion",
        f"conversion deleted: id={row.id} date=2024-01-11 kind=fx_conversion",
    ]
    assert not any("12345" in line or "15432" in line for line in lines)
