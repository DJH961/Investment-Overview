"""Filling 1D / 1W graph holes from Tiingo, and the Tiingo usage view."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
)
from investment_dashboard.services import intraday_snapshots_service as iss
from investment_dashboard.services import tiingo_usage_service

_DAY = date(2024, 6, 3)
_NOW = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)  # 16:00 ET, market just closed


def _seed_eur_holding(session: Session) -> None:
    """A EUR stock bought on the session day (no FX needed)."""
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
            date=_DAY,
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, instr.id, {_DAY: Decimal("100.00")})
    session.flush()


_OPEN = datetime(2024, 6, 3, 13, 30)  # 09:30 ET in June
_CLOSE = datetime(2024, 6, 3, 20, 0)


def _live(session: Session, start: datetime, end: datetime) -> list[datetime]:
    times = []
    t = start
    while t <= end:
        intraday_repo.insert_sample(session, t, Decimal("1000"), None, None)
        times.append(t)
        t += timedelta(minutes=1)
    session.flush()
    return times


def _seed_with_hole(session: Session) -> tuple[list[datetime], list[datetime]]:
    _seed_eur_holding(session)
    morning = _live(session, _OPEN, datetime(2024, 6, 3, 15, 0))
    afternoon = _live(session, datetime(2024, 6, 3, 17, 0), _CLOSE)
    return morning, afternoon


def _bars(_symbol: str, _start: date, _end: date) -> dict[datetime, Decimal]:
    out = {}
    t = _OPEN
    while t <= _CLOSE:
        out[t] = Decimal("101")
        t += timedelta(minutes=5)
    return out


def test_graph_gaps_finds_the_midday_hole(session: Session) -> None:
    _seed_with_hole(session)
    assert iss.graph_gaps(session, now=_NOW) == [
        (datetime(2024, 6, 3, 15, 0), datetime(2024, 6, 3, 17, 0))
    ]


def test_fill_writes_only_inside_the_hole(session: Session) -> None:
    morning, afternoon = _seed_with_hole(session)
    summary = iss.fill_gaps_from_tiingo(session, now=_NOW, fetcher=_bars, token="test")
    assert summary["gaps"] == 1
    assert summary["points"] == 23  # 15:05 ... 16:55 on the 5-minute grid
    rows = intraday_repo.list_in_range(session, _OPEN, _CLOSE)
    stored = {r.captured_at: r.market_value_eur for r in rows}
    # The app's own live points are untouched.
    assert all(stored[t] == Decimal("1000") for t in [*morning, *afternoon])
    filled = [t for t in stored if datetime(2024, 6, 3, 15, 0) < t < datetime(2024, 6, 3, 17, 0)]
    assert len(filled) == 23
    assert iss.graph_gaps(session, now=_NOW) == []


def test_fill_skips_a_day_when_tiingo_lacks_a_holding(session: Session) -> None:
    _seed_with_hole(session)
    summary = iss.fill_gaps_from_tiingo(session, now=_NOW, fetcher=lambda *_a: {}, token="test")
    assert summary["points"] == 0
    assert summary["no_bars"] == ["ACME"]


def test_fill_refuses_when_budget_cannot_cover_it(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_with_hole(session)
    monkeypatch.setattr(tiingo_usage_service, "reserve", lambda calls, now=None: (False, 0))
    with pytest.raises(iss.TiingoGapFillError, match="needs 1 Tiingo request"):
        iss.fill_gaps_from_tiingo(session, now=_NOW, token="test")


def test_no_token_is_a_clear_error(session: Session) -> None:
    _seed_with_hole(session)
    with pytest.raises(iss.TiingoGapFillError, match="No Tiingo token"):
        iss.fill_gaps_from_tiingo(session, now=_NOW, token="")


def test_reset_times() -> None:
    now = datetime(2026, 11, 6, 14, 37, tzinfo=UTC)
    assert tiingo_usage_service._next_hour(now.replace(tzinfo=None)) == datetime(2026, 11, 6, 15, 0)
    # Midnight New York (EST, UTC-5) after 09:37 ET is 05:00 UTC the next day.
    assert tiingo_usage_service._next_eastern_midnight(now.replace(tzinfo=None)) == datetime(
        2026, 11, 7, 5, 0
    )
