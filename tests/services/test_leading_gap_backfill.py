"""Leading-gap backfill regression tests.

``prices_service.refresh_prices`` and ``fx_service._refresh_single_quote`` used
to only ever extend the cached series *forward* (start = latest + 1 day). If the
cache already held recent prints but began later than the earliest date the
portfolio needs (a *leading gap* — e.g. the first refresh ran before an older
transaction was added), the early dates were never fetched and historical
valuations priced those holdings at zero. The refresh must now detect the gap
and refetch from ``earliest_needed``.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

from sqlalchemy.orm import Session

from investment_dashboard.repositories import fx_repo, instruments_repo, prices_repo
from investment_dashboard.services import fx_service, prices_service


def test_refresh_prices_backfills_leading_gap(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="FOO", asset_class="etf")
    # Cache already has recent prints but starts at 2024-06-01 — a leading gap
    # versus an earliest_needed of 2024-01-01.
    prices_repo.upsert_closes(
        session,
        instr.id,
        {date(2024, 6, 1): Decimal("10"), date(2024, 6, 3): Decimal("11")},
    )

    captured: dict[str, date] = {}

    def fake_fetch(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        captured["start"] = start
        return {"FOO": {date(2024, 1, 2): Decimal("9")}}

    with patch.object(prices_service, "fetch_closes", side_effect=fake_fetch):
        prices_service.refresh_prices(
            session, earliest_needed=date(2024, 1, 1), today=date(2024, 6, 10)
        )

    # Must refetch from the earliest needed date, not from latest + 1.
    assert captured["start"] == date(2024, 1, 1)
    assert prices_repo.earliest_price_date(session, instr.id) == date(2024, 1, 2)


def test_refresh_prices_forward_only_without_gap(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="BAR", asset_class="etf")
    prices_repo.upsert_closes(
        session,
        instr.id,
        {date(2024, 1, 1): Decimal("10"), date(2024, 6, 3): Decimal("11")},
    )

    captured: dict[str, date] = {}

    def fake_fetch(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        captured["start"] = start
        return {}

    with patch.object(prices_service, "fetch_closes", side_effect=fake_fetch):
        prices_service.refresh_prices(
            session, earliest_needed=date(2024, 1, 1), today=date(2024, 6, 10)
        )

    # No leading gap (earliest cached == earliest needed): only append forward.
    assert captured["start"] == date(2024, 6, 4)


def test_refresh_prices_repulls_today_for_already_current_holding(session: Session) -> None:
    """A manual/force refresh must re-pull *today's* window even when a today
    dated print is already cached. In the steady state (full history through
    today) the forward-only start lands on ``today + 1`` and the symbol used to
    be skipped — so a Refresh tap during market hours never fetched the latest
    intraday price for a holding that already had one. It must now always reach
    back to today and overwrite that row with the fresher print.
    """
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    today = date(2024, 6, 10)
    earliest_needed = date(2024, 5, 1)
    # Full cached history from ``earliest_needed`` through an earlier today print.
    prices_repo.upsert_closes(
        session,
        instr.id,
        {earliest_needed: Decimal("90"), today: Decimal("100")},
    )

    captured: dict[str, object] = {}

    def fake_fetch(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        captured["start"] = start
        captured["end"] = end
        captured["symbols"] = list(symbols)
        return {"VTI": {today: Decimal("101")}}  # a fresher intraday print

    # 2024-06-10 11:00 ET (15:00 UTC) is a Monday inside trading hours, so the
    # market holding anchors to *today* and re-pulls the live intraday window.
    with patch.object(prices_service, "fetch_closes", side_effect=fake_fetch):
        prices_service.refresh_prices(
            session,
            earliest_needed=earliest_needed,
            today=today,
            now=datetime(2024, 6, 10, 15, 0),
        )

    # The symbol was fetched (not skipped as "already have today"), the window
    # reached back to today, and the cached close was overwritten.
    assert captured["symbols"] == ["VTI"]
    assert captured["start"] == today
    assert captured["end"] == today + timedelta(days=1)
    assert prices_repo.latest_close(session, instr.id) == Decimal("101")


def test_refresh_prices_anchors_to_settled_close_when_market_closed(session: Session) -> None:
    """When the market is closed a manual refresh must double-check the latest
    *settled* close — re-pulling that session's window — without extending the
    request into a non-trading "today" that yfinance can only answer with an
    empty frame (which surfaces a "no data" Data Health warning).
    """
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    earliest_needed = date(2024, 5, 1)
    settled = date(2024, 6, 21)  # Friday's settled close
    today = date(2024, 6, 22)  # Saturday — market closed, no data for "today"
    # Cache already holds the settled close.
    prices_repo.upsert_closes(
        session,
        instr.id,
        {earliest_needed: Decimal("90"), settled: Decimal("105")},
    )

    captured: dict[str, date] = {}

    def fake_fetch(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        captured["start"] = start
        captured["end"] = end
        return {"VTI": {settled: Decimal("106")}}  # a corrected settled close

    # Saturday 2024-06-22 12:00 UTC — market closed.
    with patch.object(prices_service, "fetch_closes", side_effect=fake_fetch):
        prices_service.refresh_prices(
            session,
            earliest_needed=earliest_needed,
            today=today,
            now=datetime(2024, 6, 22, 12, 0),
        )

    # Window re-pulls the settled session and stops there — it never asks for
    # the non-trading Saturday, so no empty-window warning.
    assert captured["start"] == settled
    assert captured["end"] == settled + timedelta(days=1)
    assert prices_repo.latest_close(session, instr.id) == Decimal("106")


def test_refresh_prices_nav_anchors_to_settled_not_today_intraday(session: Session) -> None:
    """A NAV fund has no intraday value, so even while the market is open a
    manual refresh must anchor it to the latest settled session's NAV rather
    than requesting "today" — which for a NAV-only batch would return an empty
    intraday frame and log a "no data" Data Health warning.
    """
    instr = instruments_repo.get_or_create(session, symbol="VSMPX", asset_class="mutual_fund")
    earliest_needed = date(2024, 5, 1)
    settled = date(2024, 6, 21)  # Friday's settled NAV
    today = date(2024, 6, 24)  # Monday — market open, but NAV has no intraday
    prices_repo.upsert_closes(
        session,
        instr.id,
        {earliest_needed: Decimal("90"), settled: Decimal("110")},
    )

    captured: dict[str, date] = {}

    def fake_fetch(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        captured["start"] = start
        captured["end"] = end
        return {"VSMPX": {settled: Decimal("111")}}

    # Monday 2024-06-24 15:00 UTC (11:00 ET) — market open.
    with patch.object(prices_service, "fetch_closes", side_effect=fake_fetch):
        prices_service.refresh_prices(
            session,
            earliest_needed=earliest_needed,
            today=today,
            now=datetime(2024, 6, 24, 15, 0),
        )

    # Anchored to the settled NAV: the window re-pulls Friday and stops there,
    # never requesting the live "today" the fund cannot answer intraday.
    assert captured["start"] == settled
    assert captured["end"] == settled + timedelta(days=1)
    assert prices_repo.latest_close(session, instr.id) == Decimal("111")


def test_refresh_rates_backfills_leading_gap(session: Session) -> None:
    fx_repo.upsert_rates(
        session,
        {date(2024, 6, 1): Decimal("1.08"), date(2024, 6, 10): Decimal("1.09")},
    )

    captured: dict[str, date] = {}

    def fake_fetch(start: date, end: date, *, base: str, quote: str) -> list[object]:
        captured["start"] = start
        return []

    with patch.object(fx_service, "fetch_rates", side_effect=fake_fetch):
        fx_service._refresh_single_quote(
            session,
            earliest_needed=date(2024, 1, 1),
            today=date(2024, 6, 10),
            base="EUR",
            quote="USD",
        )

    # Tail is current (2024-06-10 >= today) but the leading gap must be filled.
    assert captured["start"] == date(2024, 1, 1)


def test_refresh_rates_noop_when_complete(session: Session) -> None:
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 1): Decimal("1.08"), date(2024, 6, 10): Decimal("1.09")},
    )

    called = False

    def fake_fetch(start: date, end: date, *, base: str, quote: str) -> list[object]:
        nonlocal called
        called = True
        return []

    with patch.object(fx_service, "fetch_rates", side_effect=fake_fetch):
        written = fx_service._refresh_single_quote(
            session,
            earliest_needed=date(2024, 1, 1),
            today=date(2024, 6, 10),
            base="EUR",
            quote="USD",
        )

    # No gap and tail current: nothing fetched.
    assert written == 0
    assert called is False
