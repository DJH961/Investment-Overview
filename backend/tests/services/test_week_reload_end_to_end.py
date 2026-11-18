"""The 1W reload end to end on a synthetic ledger: a sparse past day gets dense again.

Mocked provider only (no network). Reproduces the owner's report: one past session in
the 1W window had a handful of stored points; pressing reload must pull the day's bars
again and the 1W series must then carry them.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import intraday_repo
from investment_dashboard.services import intraday_snapshots_service as iss

from .test_intraday_snapshots_service import _NOW, _seed_eur_holding_for_week


def _dense_fetcher(calls: list[tuple[object, object, str]]):  # type: ignore[no-untyped-def]
    """Serves a full 5-minute session (13:30-20:00 UTC) for every requested day."""

    def fetch(symbols, start_day, end_day, *, interval):  # type: ignore[no-untyped-def]
        calls.append((start_day, end_day, interval))
        bars: dict[datetime, Decimal] = {}
        day = start_day
        while day <= end_day:
            if day.weekday() < 5:
                for i in range(79):
                    at = datetime(day.year, day.month, day.day, 13, 30) + timedelta(minutes=5 * i)
                    bars[at] = Decimal(100 + i % 7)
            day += timedelta(days=1)
        return {sym: dict(bars) for sym in symbols}

    return fetch


def _day_points(session: Session, day) -> list[datetime]:  # type: ignore[no-untyped-def]
    start = iss._session_start_utc(day)
    end = iss._session_start_utc(day + timedelta(days=1))
    return [r.captured_at for r in intraday_repo.list_in_range(session, start, end)]


def test_reload_week_refills_a_sparse_past_day(session: Session) -> None:
    _seed_eur_holding_for_week(session)
    sessions = iss.recent_trading_sessions(_NOW)
    sparse_day = sessions[1]
    # A sparse stored day: five points an hour and a half apart, marked as already fetched.
    base = datetime(sparse_day.year, sparse_day.month, sparse_day.day, 14, 0)
    for k in range(5):
        intraday_repo.insert_sample(
            session, base + timedelta(minutes=90 * k), Decimal("1000.00"), None, None
        )
    for d in sessions:
        iss._mark_week_day_fetched(session, d, sessions[-1])
    assert len(_day_points(session, sparse_day)) == 5

    calls: list[tuple[object, object, str]] = []
    count = iss.reload_week_graph(session, now=_NOW, fetcher=_dense_fetcher(calls))

    assert calls, "the reload never asked the provider for bars"
    assert any(start <= sparse_day <= end for start, end, _ in calls)  # type: ignore[operator]
    assert len(_day_points(session, sparse_day)) > 60
    assert count > 60 * (len(sessions) - 1)
    series = iss.week_series_with_fx(session, now=_NOW, fetcher=_dense_fetcher([]))
    assert len([s for s in series if s[0].date() == sparse_day]) > 60


def test_reload_upgrades_a_ten_minute_day_to_five_minute_bars(session: Session) -> None:
    """No hole, enough points to pass the old check, but coarser than the wanted 5m bars."""
    from investment_dashboard.repositories import app_config_repo

    _seed_eur_holding_for_week(session)
    app_config_repo.set_value(session, iss.RELOAD_INTERVAL_KEY, "5m")
    sessions = iss.recent_trading_sessions(_NOW)
    day = sessions[1]
    open_at = datetime(day.year, day.month, day.day, 13, 30)
    for k in range(40):  # 13:30 .. 20:00 every 10 minutes
        intraday_repo.insert_sample(
            session, open_at + timedelta(minutes=10 * k), Decimal("1000"), None, None
        )
    calls: list[tuple[object, object, str]] = []
    iss.reload_week_graph(session, now=_NOW, fetcher=_dense_fetcher(calls))
    assert len(_day_points(session, day)) > 70
    assert all(interval == "5m" for _, _, interval in calls)


def test_reload_at_the_edge_of_the_one_minute_window_falls_back_to_five_minutes(
    session: Session,
) -> None:
    """The oldest session is 7 days old on a Thursday morning: 1m / 2m serve nothing, 5m does."""
    from datetime import UTC, date

    from investment_dashboard.models import Transaction
    from investment_dashboard.repositories import accounts_repo, instruments_repo, prices_repo

    now = datetime(2024, 6, 13, 10, 0, tzinfo=UTC)
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR",
        native_currency="EUR",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=instr.id,
            date=date(2024, 5, 20),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    sessions = iss.recent_trading_sessions(now)
    prices_repo.upsert_closes(session, instr.id, {d: Decimal("100.00") for d in sessions})
    session.flush()
    oldest = sessions[0]
    assert (iss.exchange_today(now) - oldest).days >= 7

    asked: list[str] = []
    dense = _dense_fetcher([])

    def fetch(symbols, start_day, end_day, *, interval):  # type: ignore[no-untyped-def]
        asked.append(interval)
        if interval in ("1m", "2m"):
            return {sym: {} for sym in symbols}
        return dense(symbols, start_day, end_day, interval=interval)

    iss.reload_week_graph(session, now=now, fetcher=fetch)
    assert "5m" in asked
    assert len(_day_points(session, oldest)) > 70
    series = iss.week_series_with_fx(session, now=now, fetcher=fetch)
    assert len([s for s in series if s[0].date() == oldest]) > 70
