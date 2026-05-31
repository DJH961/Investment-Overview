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


def test_invalidate_all_drops_every_snapshot(session: Session) -> None:
    """v2.9.1 — clearing the whole cache after a FX/price backfill so the
    stale ``0`` closing values computed before the deferred refresh are
    recomputed against the now-complete history."""
    snapshots_repo.upsert_snapshot(session, date(2023, 1, 1), Decimal("0"))
    snapshots_repo.upsert_snapshot(session, date(2024, 1, 1), Decimal("0"))
    snapshots_repo.upsert_snapshot(session, date(2025, 1, 1), Decimal("0"))
    session.flush()

    dropped = snapshots_service.invalidate_all(session)
    session.flush()
    assert dropped == 3
    assert snapshots_repo.get_snapshot(session, date(2023, 1, 1)) is None
    assert snapshots_repo.get_snapshot(session, date(2024, 1, 1)) is None
    assert snapshots_repo.get_snapshot(session, date(2025, 1, 1)) is None


def test_stale_zero_snapshot_recomputes_after_invalidation(session: Session) -> None:
    """End-to-end guard for the v2.9.1 closing-value=0 bug.

    The UI opens before the deferred FX/price backfill, so the first render
    caches a period's closing value as ``0`` (no prices yet). After the
    backfill lands, ``invalidate_all`` must drop that stale zero so the next
    ``get_or_compute`` reflects the now-priced holding.
    """
    from investment_dashboard.models import Transaction
    from investment_dashboard.repositories import (
        accounts_repo,
        instruments_repo,
        prices_repo,
    )

    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct.id,
            instrument_id=instr.id,
            date=date(2025, 1, 2),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    session.flush()

    past = date(2025, 1, 31)
    # First render: prices not yet backfilled ⇒ closing value caches as 0.
    assert snapshots_service.get_or_compute(session, past) == Decimal(0)
    assert snapshots_repo.get_snapshot(session, past) is not None

    # Deferred backfill lands; prices now cover the period.
    prices_repo.upsert_closes(session, instr.id, {date(2025, 1, 31): Decimal("120.00")})
    session.flush()

    # Without invalidation the stale 0 would persist…
    assert snapshots_service.get_or_compute(session, past) == Decimal(0)
    # …but invalidate_all forces a correct recompute (10 sh × 120 = 1200).
    snapshots_service.invalidate_all(session)
    session.flush()
    assert snapshots_service.get_or_compute(session, past) == Decimal("1200.00")


def test_series_in_currency_matches_per_day_helper(session: Session) -> None:
    """The batched series equals calling ``get_or_compute_in_currency`` per day."""
    from investment_dashboard.repositories import fx_repo

    start = date(2024, 1, 1)
    end = date(2024, 1, 5)
    days = [date(2024, 1, d) for d in range(1, 6)]
    for i, day in enumerate(days):
        snapshots_repo.upsert_snapshot(session, day, Decimal(1000 + i))
    fx_repo.upsert_rates(
        session,
        {start: Decimal("1.10"), date(2024, 1, 3): Decimal("1.20")},
        base="EUR",
        quote="USD",
    )
    session.flush()

    batched = snapshots_service.series_in_currency(session, start, end, "USD")
    per_day = [
        (day, snapshots_service.get_or_compute_in_currency(session, day, "USD")) for day in days
    ]
    assert batched == per_day


def test_series_in_currency_eur_passthrough(session: Session) -> None:
    start = date(2024, 2, 1)
    end = date(2024, 2, 3)
    for d in range(1, 4):
        snapshots_repo.upsert_snapshot(session, date(2024, 2, d), Decimal(500 + d))
    session.flush()

    series = snapshots_service.series_in_currency(session, start, end, "EUR")
    assert series == [
        (date(2024, 2, 1), Decimal("501")),
        (date(2024, 2, 2), Decimal("502")),
        (date(2024, 2, 3), Decimal("503")),
    ]


def test_series_in_currency_caches_missing_historical_days(session: Session) -> None:
    """Days absent from the cache are computed and persisted (empty ⇒ 0)."""
    start = date(2024, 3, 1)
    end = date(2024, 3, 3)
    series = snapshots_service.series_in_currency(session, start, end, "EUR")
    assert [v for _, v in series] == [Decimal(0), Decimal(0), Decimal(0)]
    for d in range(1, 4):
        assert snapshots_repo.get_snapshot(session, date(2024, 3, d)) is not None


def test_series_in_currency_today_ignores_stale_cache(session: Session) -> None:
    today = date.today()
    snapshots_repo.upsert_snapshot(session, today, Decimal("9999.99"))
    session.flush()
    series = snapshots_service.series_in_currency(session, today, today, "EUR")
    # Today is always recomputed live ⇒ empty portfolio yields 0, not 9999.99.
    assert series == [(today, Decimal(0))]


def test_warm_range_computes_and_caches_each_day(session: Session) -> None:
    start = date(2024, 4, 1)
    end = date(2024, 4, 4)
    warmed = snapshots_service.warm_range(session, start, end)
    assert warmed == 4
    for d in range(1, 5):
        assert snapshots_repo.get_snapshot(session, date(2024, 4, d)) is not None


def test_warm_range_empty_when_end_before_start(session: Session) -> None:
    assert snapshots_service.warm_range(session, date(2024, 5, 2), date(2024, 5, 1)) == 0
