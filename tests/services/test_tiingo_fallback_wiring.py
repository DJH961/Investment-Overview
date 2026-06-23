"""Integration tests for the desktop Tiingo fallback wired into prices_service."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import (
    instruments_repo,
    price_cache_repo,
    prices_repo,
)
from investment_dashboard.services import prices_service, provider_status
from investment_dashboard.services import tiingo_fallback_wiring as wiring

# 22:00 UTC on a Tuesday = 18:00 ET, after the 16:00 close: today is settled.
_NOW = datetime(2026, 6, 23, 22, 0, 0)
_TODAY = date(2026, 6, 23)


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None)


@pytest.fixture(autouse=True)
def _reset_status() -> None:
    provider_status.reset()
    from investment_dashboard.services import runtime_status

    runtime_status.reset()


def _due_etf(session: Session, symbol: str = "VTI") -> int:
    instr = instruments_repo.get_or_create(session, symbol=symbol, asset_class="etf")
    # Last refreshed long ago so it's due; seed a stale held close.
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, _NOW - timedelta(hours=2))
    prices_repo.upsert_closes(session, instr.id, {date(2026, 6, 18): Decimal("100")})
    session.flush()
    return instr.id


# --------------------------------------------------------------------------- #
# expected_session_date
# --------------------------------------------------------------------------- #
def test_expected_session_date_after_close_is_today() -> None:
    assert wiring.expected_session_date(_NOW) == _TODAY


def test_expected_session_date_before_close_rolls_back() -> None:
    # 14:00 UTC = 10:00 ET, market still open -> previous trading day (Mon 22nd).
    assert wiring.expected_session_date(datetime(2026, 6, 23, 14, 0)) == date(2026, 6, 22)


def test_expected_session_date_skips_weekend_and_juneteenth() -> None:
    # Sunday 21st -> roll back past Sat 20th and Fri 19th (Juneteenth, a NYSE
    # holiday) to Thursday 18th. Exercises the holiday-aware rollback.
    assert wiring.expected_session_date(datetime(2026, 6, 21, 22, 0)) == date(2026, 6, 18)


# --------------------------------------------------------------------------- #
# Token gating
# --------------------------------------------------------------------------- #
def test_no_token_disables_fallback(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _due_etf(session)
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: None)
    # yfinance hard-fails; without a token nothing recovers.
    monkeypatch.setattr(
        prices_service,
        "fetch_closes",
        lambda *a, **k: (_ for _ in ()).throw(prices_service.YFinanceError("boom")),
    )
    called = {"tiingo": False}
    monkeypatch.setattr(
        wiring, "apply_desktop_fallback", lambda *a, **k: called.__setitem__("tiingo", True)
    )
    result = prices_service.refresh_due_prices(session, today=_TODAY, now=_NOW)
    assert result == {}
    assert called["tiingo"] is False


# --------------------------------------------------------------------------- #
# Fallback fires on yfinance failure
# --------------------------------------------------------------------------- #
def test_yfinance_failure_recovers_via_tiingo(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    instr_id = _due_etf(session)
    # First make the symbol a *confirmed* repeat failure by pre-marking stale.
    from investment_dashboard.repositories import tiingo_state_repo as state_repo

    state = state_repo.load(session, _NOW)
    state.stale_since["VTI"] = _NOW - timedelta(hours=2)
    state_repo.save(session, state)

    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: "tok")
    monkeypatch.setattr(
        prices_service,
        "fetch_closes",
        lambda *a, **k: (_ for _ in ()).throw(prices_service.YFinanceError("down")),
    )

    def _fake_tiingo(symbols, start, end, *, token):
        return {s: {_TODAY: Decimal("123.45")} for s in symbols}

    monkeypatch.setattr(wiring.tiingo_client, "fetch_closes", _fake_tiingo)

    result = prices_service.refresh_due_prices(session, today=_TODAY, now=_NOW)
    assert result.get("VTI", 0) >= 1
    # The recovered close landed in the cache.
    latest = prices_repo.latest_price_dates(session, [instr_id]).get(instr_id)
    assert latest == _TODAY
    # And the switch was recorded for the popup.
    assert provider_status.get_status("tiingo") is not None
    # The loud desktop runtime warning fired.
    from investment_dashboard.services import runtime_status

    note = runtime_status.latest()
    assert note is not None
    assert note.is_warning
    assert "Tiingo" in note.message


def test_fallback_error_is_swallowed(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _due_etf(session)
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: "tok")
    monkeypatch.setattr(prices_service, "fetch_closes", lambda *a, **k: {"VTI": {}})
    monkeypatch.setattr(
        wiring,
        "apply_desktop_fallback",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("kaboom")),
    )
    # Must not raise; primary result (stamped, zero rows) stands.
    result = prices_service.refresh_due_prices(session, today=_TODAY, now=_NOW)
    assert result == {"VTI": 0}


def test_fallback_error_is_surfaced_loudly(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A swallowed fallback failure must still be made OBVIOUS: a red runtime_status
    # error (toast + Data Health) so a silently-down backup provider is visible.
    from investment_dashboard.services import runtime_status

    _due_etf(session)
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: "tok")
    monkeypatch.setattr(
        wiring,
        "apply_desktop_fallback",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("kaboom")),
    )

    prices_service.refresh_due_prices(session, today=_TODAY, now=_NOW)

    latest = runtime_status.latest()
    assert latest is not None
    assert not latest.is_warning  # red error, not amber
    assert "Tiingo" in latest.message
    assert "kaboom" in latest.message


# --------------------------------------------------------------------------- #
# Manual "Refresh via Tiingo now"
# --------------------------------------------------------------------------- #
def test_manual_refresh_recovers_without_prior_stale_stamp(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No stale stamp pre-set: the automatic path would hold off (gate C), but the
    # manual refresh fetches immediately because newer data exists.
    instr_id = _due_etf(session)
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: "tok")

    def _fake_tiingo(symbols, start, end, *, token):
        return {s: {_TODAY: Decimal("222.0")} for s in symbols}

    monkeypatch.setattr(wiring.tiingo_client, "fetch_closes", _fake_tiingo)

    recovered, switched = prices_service.refresh_via_tiingo(session, today=_TODAY, now=_NOW)
    assert switched is True
    assert recovered.get("VTI", 0) >= 1
    assert prices_repo.latest_price_dates(session, [instr_id]).get(instr_id) == _TODAY
    # Manual refresh owns its own UX, so the automatic "yfinance couldn't deliver"
    # toast is suppressed.
    from investment_dashboard.services import runtime_status

    assert runtime_status.latest() is None


def test_manual_refresh_noop_when_up_to_date(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    price_cache_repo.upsert_last_refreshed_at(session, instr.id, _NOW - timedelta(hours=2))
    prices_repo.upsert_closes(session, instr.id, {_TODAY: Decimal("100")})  # already current
    session.flush()
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: "tok")
    called = {"fetched": False}
    monkeypatch.setattr(
        wiring.tiingo_client,
        "fetch_closes",
        lambda *a, **k: called.__setitem__("fetched", True) or {},
    )
    recovered, switched = prices_service.refresh_via_tiingo(session, today=_TODAY, now=_NOW)
    assert switched is False
    assert recovered == {}
    assert called["fetched"] is False  # worth-it gate held: no call spent


def test_manual_refresh_without_token_raises(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _due_etf(session)
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: None)
    with pytest.raises(prices_service.TiingoNotConfiguredError):
        prices_service.refresh_via_tiingo(session, today=_TODAY, now=_NOW)
