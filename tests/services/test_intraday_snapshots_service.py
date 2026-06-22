"""Tests for the Overview "1 Day" intraday value curve (capture + reconstruct)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
)
from investment_dashboard.services import intraday_snapshots_service as iss
from investment_dashboard.ui.pages._overview_query import build_intraday_value_series

# A fixed Monday session so weekday/weekend logic is deterministic.
_SESSION_DAY = date(2024, 6, 3)
_NOW = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)  # 16:00 ET, market just closed


def _seed_eur_holding(session: Session, *, close: Decimal = Decimal("100.00")) -> None:
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=instr.id,
            date=_SESSION_DAY,
            kind="buy",
            quantity=Decimal("10"),
            price_native=close,
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, instr.id, {_SESSION_DAY: close})
    session.flush()


class TestSessionWindow:
    def test_last_session_date_rolls_back_over_weekend(self) -> None:
        saturday = datetime(2024, 6, 8, 18, 0, tzinfo=UTC)
        sunday = datetime(2024, 6, 9, 18, 0, tzinfo=UTC)
        assert iss.last_session_date(saturday) == date(2024, 6, 7)  # Friday
        assert iss.last_session_date(sunday) == date(2024, 6, 7)  # Friday

    def test_last_session_date_keeps_weekday(self) -> None:
        assert iss.last_session_date(_NOW) == _SESSION_DAY

    def test_window_bounds_a_single_session(self) -> None:
        start, end = iss.session_window_utc(_NOW)
        assert start < end
        # 00:00 ET on the session day, expressed in UTC (EDT = UTC-4).
        assert start == datetime(2024, 6, 3, 4, 0)


class TestForwardFill:
    def test_picks_latest_bar_at_or_before(self) -> None:
        bars = {
            datetime(2024, 6, 3, 13, 30): Decimal("100"),
            datetime(2024, 6, 3, 14, 0): Decimal("110"),
        }
        assert iss._forward_filled(bars, datetime(2024, 6, 3, 13, 45)) == Decimal("100")
        assert iss._forward_filled(bars, datetime(2024, 6, 3, 14, 30)) == Decimal("110")
        # Before the first bar → earliest available, never None.
        assert iss._forward_filled(bars, datetime(2024, 6, 3, 13, 0)) == Decimal("100")
        assert iss._forward_filled({}, datetime(2024, 6, 3, 14, 0)) is None


def _fake_fetcher(bars: dict[datetime, Decimal]):
    def fetch(symbols, day, *, interval):  # type: ignore[no-untyped-def]
        assert interval == iss.RECONSTRUCT_INTERVAL
        return {sym: dict(bars) for sym in symbols}

    return fetch


class TestReconstruct:
    def test_reconstructs_anchored_to_daily_total(self, session: Session) -> None:
        _seed_eur_holding(session)
        bars = {
            datetime(2024, 6, 3, 13, 30): Decimal("100"),  # +0%
            datetime(2024, 6, 3, 14, 0): Decimal("110"),  # +10%
        }
        written = iss.reconstruct_last_session(session, now=_NOW, fetcher=_fake_fetcher(bars))
        session.flush()
        assert written == 2
        series = iss.day_series_eur(session, now=_NOW)
        assert [v for _, v in series] == [Decimal("1000.00"), Decimal("1100.00")]

    def test_is_guarded_to_one_fetch_per_session(self, session: Session) -> None:
        _seed_eur_holding(session)
        calls = {"n": 0}

        def fetch(symbols, day, *, interval):  # type: ignore[no-untyped-def]
            calls["n"] += 1
            return {sym: {datetime(2024, 6, 3, 13, 30): Decimal("100")} for sym in symbols}

        iss.reconstruct_last_session(session, now=_NOW, fetcher=fetch)
        session.flush()
        iss.reconstruct_last_session(session, now=_NOW, fetcher=fetch)
        session.flush()
        assert calls["n"] == 1  # second call short-circuits on the app_config guard


class TestBuildIntradaySeries:
    def test_merges_dense_live_points_with_reconstruction(self, session: Session) -> None:
        _seed_eur_holding(session)
        # Coarse reconstructed bars …
        iss.reconstruct_last_session(
            session,
            now=_NOW,
            fetcher=_fake_fetcher({datetime(2024, 6, 3, 13, 30): Decimal("100")}),
        )
        # … plus several dense live captures within the same session window.
        for minute in (40, 41, 42):
            intraday_repo.insert_sample(
                session, datetime(2024, 6, 3, 19, minute), Decimal("1050.00")
            )
        session.flush()

        points = build_intraday_value_series(session, currency="EUR", now=_NOW)
        # 1 reconstructed + 3 live + 1 live "now" tip — the dense hour is kept.
        assert len(points) >= 5
        assert points[0].value == Decimal("1000.00")
        # Strictly increasing timestamps (sorted, merged).
        stamps = [p.date for p in points]
        assert stamps == sorted(stamps)

    def test_empty_portfolio_has_no_points(self, session: Session) -> None:
        assert build_intraday_value_series(session, currency="EUR", now=_NOW) == []
