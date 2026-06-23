"""yfinance historical-FX overlay tests.

``fx_service.refresh_fx_history_yfinance`` re-marks the EUR/USD history at
yfinance's actual ``EURUSD=X`` market close, on top of the ECB/Frankfurter
baseline, so a recreated equity curve converts a USD-native portfolio into euros
at each day's real rate. These tests use an injected fetcher (no network).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import FxHistory
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import fx_service


def _row(session: Session, on: date) -> FxHistory | None:
    stmt = select(FxHistory).where(
        FxHistory.date == on, FxHistory.base == "EUR", FxHistory.quote == "USD"
    )
    return session.scalars(stmt).one_or_none()


def test_yfinance_overlay_remarks_ecb_rate_with_market_close(session: Session) -> None:
    # ECB baseline already present (from the Frankfurter backfill).
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 2): Decimal("1.08"), date(2024, 1, 3): Decimal("1.09")},
        source="frankfurter",
    )

    def fake_history(start: date, end: date) -> dict[date, Decimal]:
        # yfinance market closes differ slightly from the ECB fixing.
        return {date(2024, 1, 2): Decimal("1.0825"), date(2024, 1, 3): Decimal("1.0912")}

    written = fx_service.refresh_fx_history_yfinance(
        session,
        earliest_needed=date(2024, 1, 1),
        today=date(2024, 1, 3),
        fetcher=fake_history,
    )

    assert written == 2
    row = _row(session, date(2024, 1, 2))
    assert row is not None
    assert row.rate == Decimal("1.0825")  # re-marked to the yfinance close
    assert row.source == "yfinance"


def test_yfinance_overlay_only_supports_usd(session: Session) -> None:
    called = False

    def fake_history(start: date, end: date) -> dict[date, Decimal]:
        nonlocal called
        called = True
        return {}

    written = fx_service.refresh_fx_history_yfinance(
        session,
        earliest_needed=date(2024, 1, 1),
        today=date(2024, 1, 3),
        quote="DKK",
        fetcher=fake_history,
    )
    assert written == 0
    assert called is False


def test_yfinance_overlay_noop_when_already_covered(session: Session) -> None:
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 1): Decimal("1.08"), date(2024, 1, 3): Decimal("1.09")},
        source="yfinance",
    )

    called = False

    def fake_history(start: date, end: date) -> dict[date, Decimal]:
        nonlocal called
        called = True
        return {}

    written = fx_service.refresh_fx_history_yfinance(
        session,
        earliest_needed=date(2024, 1, 1),
        today=date(2024, 1, 3),
        fetcher=fake_history,
    )
    assert written == 0
    assert called is False


def test_yfinance_overlay_fills_leading_gap(session: Session) -> None:
    # yfinance coverage starts later than needed → must refetch from the floor.
    fx_repo.upsert_rates(session, {date(2024, 6, 1): Decimal("1.07")}, source="yfinance")

    captured: dict[str, date] = {}

    def fake_history(start: date, end: date) -> dict[date, Decimal]:
        captured["start"] = start
        return {date(2024, 1, 2): Decimal("1.10")}

    fx_service.refresh_fx_history_yfinance(
        session,
        earliest_needed=date(2024, 1, 1),
        today=date(2024, 6, 10),
        fetcher=fake_history,
    )
    assert captured["start"] == date(2024, 1, 1)


def test_yfinance_overlay_keeps_ecb_rates_on_failure(session: Session) -> None:
    fx_repo.upsert_rates(session, {date(2024, 1, 2): Decimal("1.08")}, source="frankfurter")

    def boom(start: date, end: date) -> dict[date, Decimal]:
        raise RuntimeError("network down")

    written = fx_service.refresh_fx_history_yfinance(
        session,
        earliest_needed=date(2024, 1, 1),
        today=date(2024, 1, 3),
        fetcher=boom,
    )
    assert written == 0
    row = _row(session, date(2024, 1, 2))
    assert row is not None
    assert row.rate == Decimal("1.08")  # ECB rate preserved
    assert row.source == "frankfurter"


def test_yfinance_overlay_drops_non_positive_closes(session: Session) -> None:
    def fake_history(start: date, end: date) -> dict[date, Decimal]:
        return {date(2024, 1, 2): Decimal("0"), date(2024, 1, 3): Decimal("1.09")}

    written = fx_service.refresh_fx_history_yfinance(
        session,
        earliest_needed=date(2024, 1, 1),
        today=date(2024, 1, 3),
        fetcher=fake_history,
    )
    assert written == 1
    assert _row(session, date(2024, 1, 2)) is None
    good = _row(session, date(2024, 1, 3))
    assert good is not None
    assert good.rate == Decimal("1.09")
