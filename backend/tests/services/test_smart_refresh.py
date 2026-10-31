"""Tests for the v1.2 TTL-based smart price-refresh logic."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import (
    instruments_repo,
    price_cache_repo,
    prices_repo,
)
from investment_dashboard.services import prices_service


def _utc_naive(when: datetime) -> datetime:
    return when.replace(tzinfo=None)


# Naive-UTC instants on Monday 2024-06-24 (a regular, non-holiday session):
# 15:00 UTC == 11:00 ET (market open); 22:00 UTC == 18:00 ET (after the close).
# The latest *settled* session is the prior Friday (06-21) while the market is
# open or before it, and 06-24 itself once that day's 16:00 ET close has passed.
_MARKET_OPEN_NOW = datetime(2024, 6, 24, 15, 0)
_AFTER_CLOSE_NOW = datetime(2024, 6, 24, 22, 0)
_FRIDAY = date(2024, 6, 21)
_MONDAY = date(2024, 6, 24)


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


def _seed_close(session: Session, instrument_id: int, when: date) -> None:
    prices_repo.upsert_closes(session, instrument_id, {when: Decimal("100")})
    session.flush()


def test_market_symbol_due_while_session_open(session: Session) -> None:
    # Market open: stocks/ETFs are pulled live even though we already hold the
    # latest settled close — the user is watching intraday moves.
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    session.flush()
    _seed_close(session, instr.id, _FRIDAY)  # latest settled close in hand
    due = prices_service.instruments_due_for_refresh(session, now=_MARKET_OPEN_NOW)
    assert [i.symbol for i in due] == ["VTI"]


def test_market_symbol_skipped_when_closed_with_settled_close(session: Session) -> None:
    # Market closed and today's official close is already cached → nothing can
    # have changed, so it must NOT be re-fetched (the overnight/weekend churn
    # that made yfinance log "no data" every couple of minutes).
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    session.flush()
    _seed_close(session, instr.id, _MONDAY)  # the settled close is in hand
    due = prices_service.instruments_due_for_refresh(session, now=_AFTER_CLOSE_NOW)
    assert due == []


def test_market_symbol_due_after_bell_to_capture_settled_close(session: Session) -> None:
    # Market closed but we only hold the prior session's close → due once so the
    # official settled close gets captured after the bell.
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    session.flush()
    _seed_close(session, instr.id, _FRIDAY)  # still missing Monday's close
    due = prices_service.instruments_due_for_refresh(session, now=_AFTER_CLOSE_NOW)
    assert [i.symbol for i in due] == ["VTI"]


def test_mutual_fund_due_after_hours_when_nav_behind(session: Session) -> None:
    # NAV publishes after the close: due once the settled session is ahead of the
    # cached value-date.
    instr = instruments_repo.get_or_create(session, symbol="VSMPX", asset_class="mutual_fund")
    session.flush()
    _seed_close(session, instr.id, _FRIDAY)  # behind Monday's settled NAV
    due = prices_service.instruments_due_for_refresh(session, now=_AFTER_CLOSE_NOW)
    assert [i.symbol for i in due] == ["VSMPX"]


def test_mutual_fund_skipped_when_todays_nav_cached(session: Session) -> None:
    # Today's NAV already in hand → not due even after the close.
    instr = instruments_repo.get_or_create(session, symbol="VSMPX", asset_class="mutual_fund")
    session.flush()
    _seed_close(session, instr.id, _MONDAY)
    due = prices_service.instruments_due_for_refresh(session, now=_AFTER_CLOSE_NOW)
    assert due == []


def test_mutual_fund_not_chased_intraday(session: Session) -> None:
    # NAV is a once-a-day figure: while the market is open it is never polled, so
    # holding the latest settled NAV keeps it off the due list.
    instr = instruments_repo.get_or_create(session, symbol="VSMPX", asset_class="mutual_fund")
    session.flush()
    _seed_close(session, instr.id, _FRIDAY)  # the latest settled NAV, mid-session
    due = prices_service.instruments_due_for_refresh(session, now=_MARKET_OPEN_NOW)
    assert due == []


def test_refresh_due_prices_no_due_returns_empty(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    now = _utc_naive(datetime.now(UTC))
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, now)  # just refreshed
    session.flush()
    # No yfinance call should happen because nothing is due.
    assert prices_service.refresh_due_prices(session, now=now) == {}


def test_refresh_due_prices_stamps_even_without_new_closes(session: Session, monkeypatch) -> None:
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


def test_refresh_due_prices_stamps_provider_market_time(session: Session, monkeypatch) -> None:
    """The live refresh records yfinance's market time (when the price is from),
    surfaced via ``market_time_for`` so the settled-today caption can date the
    figure by the exchange rather than by our pull instant."""
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    stale = _utc_naive(datetime.now(UTC)) - timedelta(hours=1)
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, stale)
    session.flush()

    monkeypatch.setattr(prices_service, "fetch_closes", lambda *a, **k: {"VTI": {}})
    market = datetime(2024, 6, 24, 19, 59)
    monkeypatch.setattr(prices_service, "fetch_market_times", lambda symbols: {"VTI": market})

    now = _utc_naive(datetime.now(UTC))
    prices_service.refresh_due_prices(session, now=now)

    # Pull time and market time are recorded separately.
    assert prices_service.last_refreshed_at_for(session, [instr.id])[instr.id] == now
    assert prices_service.market_time_for(session, [instr.id])[instr.id] == market


def test_refresh_due_prices_tolerates_market_time_failure(session: Session, monkeypatch) -> None:
    """A market-time lookup failure must never break the price refresh itself."""
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    stale = _utc_naive(datetime.now(UTC)) - timedelta(hours=1)
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, stale)
    session.flush()

    monkeypatch.setattr(prices_service, "fetch_closes", lambda *a, **k: {"VTI": {}})

    def boom(symbols):  # type: ignore[no-untyped-def]
        raise RuntimeError("quote endpoint down")

    monkeypatch.setattr(prices_service, "fetch_market_times", boom)

    now = _utc_naive(datetime.now(UTC))
    # The refresh still succeeds and stamps the pull time.
    assert prices_service.refresh_due_prices(session, now=now) == {"VTI": 0}
    assert prices_service.last_refreshed_at_for(session, [instr.id])[instr.id] == now
    assert prices_service.market_time_for(session, [instr.id]) == {}
