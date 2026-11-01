# ruff: noqa: PT018
"""Tests for ``services.fx_conversion_service``."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Account, FxHistory, Transaction
from investment_dashboard.services import fx_conversion_service as svc

D = Decimal


def _seed(session: Session) -> None:
    usd = Account(broker="vanguard", account_label="V", native_currency="USD")
    eur = Account(broker="savings_bank", account_label="E", native_currency="EUR")
    session.add_all([usd, eur])
    session.flush()
    session.add(FxHistory(date=date(2024, 1, 1), base="EUR", quote="USD", rate=D("1.25")))

    def tx(acct: Account, kind: str, on: date, amt: str) -> None:
        session.add(
            Transaction(account_id=acct.id, date=on, kind=kind, net_native=D(amt), source="manual")
        )

    tx(usd, "deposit", date(2024, 2, 1), "1000")
    tx(usd, "transfer_in", date(2024, 3, 1), "1000")
    tx(usd, "withdrawal", date(2024, 3, 2), "-100")
    tx(eur, "deposit", date(2024, 3, 3), "500")
    session.flush()


def test_crud_roundtrip(session: Session) -> None:
    row = svc.create_conversion(
        session, on=date(2024, 1, 10), eur_sent=D("100"), usd_received=D("110")
    )
    assert svc.get_conversion(session, row.id) is not None
    upd = svc.update_conversion(
        session, row.id, on=date(2024, 1, 11), eur_sent=D("200"), usd_received=D("220"), note="x"
    )
    assert upd is not None and upd.eur_sent == D("200") and upd.note == "x"
    assert len(svc.list_conversions(session)) == 1
    assert svc.delete_conversion(session, row.id) is True
    assert svc.delete_conversion(session, row.id) is False
    missing = svc.update_conversion(
        session, 99, on=date(2024, 1, 1), eur_sent=D("1"), usd_received=D("1")
    )
    assert missing is None


def test_validation(session: Session) -> None:
    with pytest.raises(ValueError, match=r"positive|future"):
        svc.create_conversion(session, on=date(2024, 1, 1), eur_sent=D("0"), usd_received=D("1"))
    with pytest.raises(ValueError, match=r"positive|future"):
        svc.create_conversion(
            session,
            on=date.today() + timedelta(days=1),
            eur_sent=D("1"),
            usd_received=D("1"),
        )


def test_no_conversions_means_no_overrides(session: Session) -> None:
    _seed(session)
    assert svc.effective_eur_overrides(session) == {}


def test_overrides_and_pool_report(session: Session) -> None:
    _seed(session)
    # 1500 USD for EUR 1100 + 100 fee = EUR 1200
    svc.create_conversion(
        session,
        on=date(2024, 1, 15),
        eur_sent=D("1100"),
        usd_received=D("1500"),
        fees_eur=D("100"),
    )
    report = svc.pool_report(session)
    assert [m.usd for m in report.result.deposits] == [D("1000"), D("1000")]  # USD deposits only
    overrides = svc.effective_eur_overrides(session)
    assert len(overrides) == 2
    first, second = (overrides[m.deposit_id] for m in report.result.deposits)
    assert first == D("800")  # 1000 * 1200/1500
    # second: 500 USD from the batch (EUR 400) + 500 USD fallback at 1.25 -> EUR 400
    assert second == D("800")
    assert report.result.remaining_usd == 0
