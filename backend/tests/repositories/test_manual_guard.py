"""Refresh upserts never overwrite hand-entered (``source='manual'``) rows."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import fx_repo, prices_repo, splits_repo

D = date(2026, 1, 5)


def test_price_upsert_keeps_manual_close(session: Session) -> None:
    prices_repo.upsert_closes(session, 1, {D: Decimal("10")}, source="manual")
    prices_repo.upsert_closes(session, 1, {D: Decimal("99"), date(2026, 1, 6): Decimal("11")})
    rows = prices_repo.list_closes(session, 1)
    assert rows == [
        (D, Decimal("10.000000"), "manual"),
        (date(2026, 1, 6), Decimal("11.000000"), "yfinance"),
    ]
    prices_repo.upsert_closes(
        session, 1, {D: Decimal("12")}, source="manual", overwrite_manual=True
    )
    assert prices_repo.get_close_row(session, 1, D) == (Decimal("12.000000"), "manual")
    assert prices_repo.delete_for_instrument(session, 1, keep_manual=True) == 1
    assert prices_repo.list_closes(session, 1) == [(D, Decimal("12.000000"), "manual")]
    assert prices_repo.delete_close(session, 1, D)


def test_fx_upsert_keeps_manual_rate(session: Session) -> None:
    fx_repo.upsert_rates(session, {D: Decimal("1.1")}, source="manual")
    fx_repo.upsert_rates(session, {D: Decimal("1.2")})
    assert fx_repo.get_rate_row(session, D) == (Decimal("1.10000000"), "manual")
    # Non-manual rows still update.
    fx_repo.upsert_rates(session, {date(2026, 1, 6): Decimal("1.3")})
    fx_repo.upsert_rates(session, {date(2026, 1, 6): Decimal("1.4")})
    assert fx_repo.get_rate_row(session, date(2026, 1, 6)) == (Decimal("1.40000000"), "frankfurter")
    assert [r[0] for r in fx_repo.list_rates(session, start=D, end=D)] == [D]
    assert fx_repo.delete_rate(session, D)


def test_split_upsert_keeps_manual_split(session: Session) -> None:
    splits_repo.upsert_splits(session, 1, {D: Decimal("1")}, source="manual")
    splits_repo.upsert_splits(session, 1, {D: Decimal("2")})
    assert splits_repo.list_splits(session, 1) == [(D, Decimal("1.00000000"), "manual")]
    assert splits_repo.delete_for_instrument(session, 1, keep_manual=True) == 0
    assert splits_repo.delete_split(session, 1, D)
