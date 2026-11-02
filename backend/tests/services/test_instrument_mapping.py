"""Instrument mapping: provider symbol + pricing mode drive the price fetch paths."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any
from unittest.mock import patch

from sqlalchemy.orm import Session

from investment_dashboard.repositories import (
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import prices_service

DAY = date(2024, 3, 1)
NOW = datetime(2024, 3, 4, 22, 0)  # a Monday evening, market closed


def _seed(session: Session) -> tuple[int, int, int]:
    a = instruments_repo.get_or_create(session, symbol="AAA.B", asset_class="stock")
    b = instruments_repo.get_or_create(session, symbol="BBB", asset_class="etf")
    c = instruments_repo.get_or_create(session, symbol="CCC", asset_class="etf")
    instrument_overrides_repo.upsert(session, a.id, provider_symbol="AAA-B")
    instrument_overrides_repo.upsert(session, b.id, pricing_mode="delisted")
    instrument_overrides_repo.upsert(session, c.id, pricing_mode="manual")
    return a.id, b.id, c.id


def test_refresh_prices_uses_provider_symbol_and_skips_frozen(session: Session) -> None:
    a, b, _c = _seed(session)
    asked: list[list[str]] = []

    def fake(symbols: list[str], start: date, end: date) -> dict[str, Any]:
        asked.append(list(symbols))
        return {s: {DAY: Decimal("10")} for s in symbols}

    with patch.object(prices_service, "fetch_closes", side_effect=fake):
        result = prices_service.refresh_prices(
            session, earliest_needed=DAY, today=date(2024, 3, 4), now=NOW
        )
    assert asked == [["AAA-B"]]
    assert result == {"AAA.B": 1}
    assert prices_repo.latest_price_dates(session, [a, b]) == {a: DAY}


def test_due_list_skips_manual_and_delisted(session: Session) -> None:
    a, _b, _c = _seed(session)
    due = prices_service.instruments_due_for_refresh(session, now=NOW)
    assert [i.id for i in due] == [a]


def test_via_provider_symbols_rekeys_and_drops(session: Session) -> None:
    _seed(session)
    calls: list[list[str]] = []

    def fetch(symbols: list[str], *_a: object) -> dict[str, str]:
        calls.append(list(symbols))
        return {s: f"bars:{s}" for s in symbols}

    wrapped = prices_service.via_provider_symbols(session, fetch)
    assert wrapped(["AAA.B", "BBB", "ZZZ"], DAY) == {"AAA.B": "bars:AAA-B", "ZZZ": "bars:ZZZ"}
    assert calls == [["AAA-B", "ZZZ"]]
