"""Manual closes / FX rates / splits survive refreshes and invalidate snapshots."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.models import Instrument, PositionSnapshot
from investment_dashboard.services import fx_service, prices_service

D = date(2026, 1, 5)


def _instrument(session: Session) -> int:
    instr = Instrument(symbol="AAA", name="Fund A", asset_class="etf", native_currency="USD")
    session.add(instr)
    session.flush()
    return instr.id


def _snapshot(session: Session, on: date) -> None:
    session.add(
        PositionSnapshot(
            snapshot_date=on, total_value_eur=Decimal("1"), computed_at=datetime(2026, 1, 9)
        )
    )
    session.flush()


def _snapshot_dates(session: Session) -> list[date]:
    return sorted(r.snapshot_date for r in session.query(PositionSnapshot))


def test_manual_close_survives_refresh_and_invalidates(session: Session) -> None:
    iid = _instrument(session)
    _snapshot(session, date(2026, 1, 2))
    _snapshot(session, date(2026, 1, 7))
    prices_service.set_manual_close(session, iid, D, Decimal("10.5"))
    assert _snapshot_dates(session) == [date(2026, 1, 2)]
    # What a refresh does:
    prices_service.store_closes(session, iid, {D: Decimal("99")}, source="yfinance")
    assert prices_service.list_closes(session, iid) == [(D, Decimal("10.500000"), "manual")]
    assert prices_service.clear_manual_close(session, iid, D) is True
    assert prices_service.list_closes(session, iid) == []
    with pytest.raises(NotFoundError):
        prices_service.clear_manual_close(session, iid, D)
    with pytest.raises(ValidationError):
        prices_service.set_manual_close(session, iid, D, Decimal("-1"))
    with pytest.raises(NotFoundError):
        prices_service.set_manual_close(session, iid + 99, D, Decimal("1"))


def test_redownload_keeps_manual_rows(session: Session) -> None:
    iid = _instrument(session)
    prices_service.set_manual_close(session, iid, D, Decimal("10"))
    prices_service.store_closes(session, iid, {date(2026, 1, 6): Decimal("11")}, source="yfinance")
    assert prices_service.invalidate_instrument_prices(session, iid, keep_manual=True) == 1
    assert [r[2] for r in prices_service.list_closes(session, iid)] == ["manual"]


def test_manual_split(session: Session) -> None:
    iid = _instrument(session)
    _snapshot(session, date(2025, 6, 1))
    prices_service.set_manual_split(session, iid, D, Decimal("2"))
    assert _snapshot_dates(session) == []
    assert prices_service.list_splits(session, iid) == [(D, Decimal("2.00000000"), "manual")]
    prices_service.delete_split(session, iid, D)
    assert prices_service.list_splits(session, iid) == []


def test_manual_fx_rate(session: Session) -> None:
    _snapshot(session, date(2026, 1, 9))
    fx_service.set_manual_rate(session, "usd", D, Decimal("1.0850"))
    assert _snapshot_dates(session) == []
    rows = fx_service.list_rates(session, "USD")
    assert rows == [(D, Decimal("1.08500000"), "manual")]
    assert fx_service.clear_manual_rate(session, "USD", D) is True
    with pytest.raises(ValidationError):
        fx_service.set_manual_rate(session, "EUR", D, Decimal("1"))
