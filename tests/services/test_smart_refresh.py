"""Tests for the v1.2 TTL-based smart price-refresh logic."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from investment_dashboard.repositories import instruments_repo, price_cache_repo
from investment_dashboard.services import prices_service


def _utc_naive(when: datetime) -> datetime:
    return when.replace(tzinfo=None)


def test_instruments_due_includes_brand_new_etf(session: Session) -> None:
    instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    session.flush()
    due = prices_service.instruments_due_for_refresh(session)
    assert [i.symbol for i in due] == ["VTI"]


def test_instruments_due_excludes_synthetic_cash(session: Session) -> None:
    instruments_repo.get_or_create(session, symbol="SAVINGS_CASH", asset_class="cash")
    session.flush()
    due = prices_service.instruments_due_for_refresh(session)
    assert due == []


def test_instruments_due_respects_ttl_etf(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    now = _utc_naive(datetime.now(UTC))
    # Last refreshed 30 seconds ago — under the 2-minute ETF TTL.
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, now - timedelta(seconds=30))
    session.flush()
    due = prices_service.instruments_due_for_refresh(session, now=now)
    assert due == []

    # 3 minutes ago — past TTL.
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, now - timedelta(minutes=3))
    session.flush()
    due = prices_service.instruments_due_for_refresh(session, now=now)
    assert [i.symbol for i in due] == ["VTI"]


def test_instruments_due_respects_ttl_mutual_fund(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VSMPX", asset_class="mutual_fund")
    now = _utc_naive(datetime.now(UTC))
    # 3 hours ago — under the 6-hour mutual-fund TTL.
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, now - timedelta(hours=3))
    session.flush()
    assert prices_service.instruments_due_for_refresh(session, now=now) == []

    # 7 hours ago — past TTL.
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, now - timedelta(hours=7))
    session.flush()
    due = prices_service.instruments_due_for_refresh(session, now=now)
    assert [i.symbol for i in due] == ["VSMPX"]


def test_refresh_due_prices_no_due_returns_empty(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    now = _utc_naive(datetime.now(UTC))
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, now)  # just refreshed
    session.flush()
    # No yfinance call should happen because nothing is due.
    assert prices_service.refresh_due_prices(session, now=now) == {}


def test_refresh_due_prices_stamps_even_without_new_closes(
    session: Session, monkeypatch
) -> None:
    """The per-symbol 'updated' time must advance whenever we successfully query
    the feed — even when it returns no new closes (after hours / weekends) —
    otherwise the overview's last-updated time freezes (the '7:51' bug)."""
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    stale = _utc_naive(datetime.now(UTC)) - timedelta(hours=1)
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, stale)
    session.flush()

    # Feed responds successfully but has nothing new for this symbol.
    monkeypatch.setattr(prices_service, "fetch_closes", lambda *a, **k: {"VTI": {}})

    now = _utc_naive(datetime.now(UTC))
    result = prices_service.refresh_due_prices(session, now=now)

    # Zero rows written, but the refresh timestamp advanced to ``now``.
    assert result == {"VTI": 0}
    stamped = price_cache_repo.get_last_refreshed_at_map(session, [instr.id])
    assert stamped[instr.id] == now
