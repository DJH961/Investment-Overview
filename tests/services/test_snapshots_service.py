"""Tests for the v1.2 snapshots-cache service."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import snapshots_repo
from investment_dashboard.services import snapshots_service


def test_get_or_compute_writes_through_for_historical_date(session: Session) -> None:
    yesterday = date.today().replace(day=1)  # any date < today
    if yesterday >= date.today():
        yesterday = date(2000, 1, 1)
    value = snapshots_service.get_or_compute(session, yesterday)
    assert value == Decimal(0)  # empty portfolio
    stored = snapshots_repo.get_snapshot(session, yesterday)
    assert stored is not None
    assert stored.total_value_eur == Decimal(0)


def test_get_or_compute_returns_cached_value_for_historical_date(session: Session) -> None:
    past = date(2020, 6, 15)
    snapshots_repo.upsert_snapshot(session, past, Decimal("1234.56"))
    session.flush()
    value = snapshots_service.get_or_compute(session, past)
    assert value == Decimal("1234.56")


def test_get_or_compute_today_always_recomputes(session: Session) -> None:
    today = date.today()
    # Seed an obviously-wrong stored snapshot for today.
    snapshots_repo.upsert_snapshot(session, today, Decimal("9999.99"))
    session.flush()
    value = snapshots_service.get_or_compute(session, today)
    # Empty portfolio ⇒ 0 even though the cache had 9999.99 — today is live.
    assert value == Decimal(0)


def test_invalidate_from_drops_subsequent_snapshots(session: Session) -> None:
    snapshots_repo.upsert_snapshot(session, date(2023, 1, 1), Decimal("100"))
    snapshots_repo.upsert_snapshot(session, date(2024, 1, 1), Decimal("200"))
    snapshots_repo.upsert_snapshot(session, date(2025, 1, 1), Decimal("300"))
    session.flush()

    dropped = snapshots_service.invalidate_from(session, date(2024, 1, 1))
    session.flush()
    assert dropped == 2
    assert snapshots_repo.get_snapshot(session, date(2023, 1, 1)) is not None
    assert snapshots_repo.get_snapshot(session, date(2024, 1, 1)) is None
    assert snapshots_repo.get_snapshot(session, date(2025, 1, 1)) is None
