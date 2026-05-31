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

from datetime import date
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
