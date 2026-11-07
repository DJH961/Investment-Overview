"""Integration tests for the desktop Tiingo fallback wired into prices_service."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

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


def test_tiingo_is_asked_for_the_provider_symbol(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.repositories import instrument_overrides_repo

    instr_id = _due_etf(session)
    instrument_overrides_repo.upsert(session, instr_id, provider_symbol="VTI-X")
    session.flush()
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
    asked: list[str] = []

    def _fake_tiingo(symbols, start, end, *, token):
        asked.extend(symbols)
        return {s: {_TODAY: Decimal("123.45")} for s in symbols}

    monkeypatch.setattr(wiring.tiingo_client, "fetch_closes", _fake_tiingo)
    prices_service.refresh_due_prices(session, today=_TODAY, now=_NOW)
    assert "VTI-X" in asked
    assert "VTI" not in asked
    assert prices_repo.latest_price_dates(session, [instr_id]).get(instr_id) == _TODAY


def test_rate_limit_exhausts_the_hourly_budget(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # When Tiingo answers HTTP 429, the account's hourly allowance is spent — the
    # wiring must pin the hourly bucket to its cap (and stamp the 429) so no
    # further call fires until the next :00, even though our own counter had room.
    import contextlib

    from investment_dashboard.adapters._retry import RateLimitedError
    from investment_dashboard.repositories import tiingo_state_repo as state_repo

    _due_etf(session)
    state = state_repo.load(session, _NOW)
    state.stale_since["VTI"] = _NOW - timedelta(hours=2)
    state_repo.save(session, state)

    # The quota-state save now opens its own short-lived ``ledger_session_scope()``
    # (see ``tiingo_fallback_wiring._save_state_best_effort``) instead of riding
    # the session the caller passed in, so it no longer shares this test's
    # fixture engine. Redirect it back to ``session`` so the assertions below
    # still observe the save.
    @contextlib.contextmanager
    def _fake_ledger_scope():
        yield session

    monkeypatch.setattr("investment_dashboard.db.ledger_session_scope", _fake_ledger_scope)

    def _rate_limited(symbols, start, end, *, token):
        raise RateLimitedError("HTTP 429 (rate limited)")

    with pytest.raises(RateLimitedError):
        wiring.apply_desktop_fallback(
            session,
            session,
            due=instruments_repo.list_instruments(session),
            now_utc=_NOW,
            today=_TODAY,
            primary_closes={},
            token="tok",
            fetch_closes_impl=_rate_limited,
        )

    after = state_repo.load(session, _NOW)
    assert after.hour_used == after.hourly_cap
    assert after.budget().has_room() is False
    assert after.rate_limited_at == _NOW


def test_state_save_lock_does_not_poison_ledger_session_or_abort_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression test for the Nov 2026 "Scheduled live refresh: PendingRollbackError"
    production incident.

    In production ``apply_desktop_fallback`` is handed two *different* Session
    objects (the scheduler's ``ledger`` and ``cache`` sessions — see
    ``services/auto_refresh.tick_refresh``), often sharing one physical SQLite
    file. A plain writer/writer collision between them — ``cache``'s recovered-
    close write is still uncommitted when the quota-state save tries to write
    its ``tiingo_desktop_state`` counters — can fail that write with
    ``OperationalError: database is locked``.

    The quota-state save now opens its **own** short-lived
    ``ledger_session_scope()`` (see ``_save_state_best_effort``) instead of
    riding the caller's ``ledger`` session, specifically so this collision can
    no longer poison anything shared: a fresh throwaway connection either
    commits fine or fails and rolls *itself* back, never touching ``ledger`` or
    ``cache``. Before that change, the save used the caller's own ``ledger``
    session; a failed flush propagated out of ``_save_state_best_effort``
    without a rollback, leaving that (shared, long-lived) session "pending
    rollback" — the *next* flush/commit on it (the scheduler's own ambient
    ``session.commit()`` when its ``with ledger_session_scope()`` block
    exited) then raised ``PendingRollbackError`` and could abort the whole
    refresh, even though the recovered Tiingo closes had already landed fine
    on the separate cache session.

    Uses real ``Session`` objects bound to one *file-backed* engine (not the
    single shared ``session`` fixture most of this file uses, and not the
    ``:memory:`` ``engine`` fixture either — SQLite gives every connection to
    ``:memory:`` its own private database, so two sessions on it are never
    truly independent the way two production sessions sharing one on-disk file
    are) with no mocking of the lock itself: ``ledger_session_scope`` is
    redirected to open new sessions on this same file-backed engine (mirroring
    how it really binds to whatever physical file the ledger tier uses), so
    the quota-state save's internal session genuinely collides with cache's
    uncommitted write.
    """
    import contextlib

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from investment_dashboard.models import ALL_METADATAS
    from investment_dashboard.repositories import tiingo_state_repo as state_repo

    db_path = tmp_path / "wiring.sqlite"
    # timeout=0: fail a lock collision immediately instead of retrying for the
    # DBAPI's default few seconds (keeps this test fast and deterministic).
    file_engine = create_engine(
        f"sqlite:///{db_path.as_posix()}", future=True, connect_args={"timeout": 0}
    )
    for md in ALL_METADATAS:
        md.create_all(file_engine)
    factory = sessionmaker(bind=file_engine, autoflush=False, expire_on_commit=False)
    ledger = factory()
    cache = factory()

    @contextlib.contextmanager
    def _file_ledger_scope():
        """Mirror ``db._scope`` but bound to this test's file engine."""
        s = factory()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    monkeypatch.setattr("investment_dashboard.db.ledger_session_scope", _file_ledger_scope)
    try:
        instr_id = _due_etf(ledger)
        # A confirmed repeat failure (matches test_yfinance_failure_recovers_via_tiingo)
        # so the fallback's worth-it gate actually fetches VTI.
        state = state_repo.load(ledger, _NOW)
        state.stale_since["VTI"] = _NOW - timedelta(hours=2)
        state_repo.save(ledger, state)
        ledger.commit()  # committed so the separate `cache` connection can see it

        def _fake_tiingo(symbols, start, end, *, token):
            return {s: {_TODAY: Decimal("123.45")} for s in symbols}

        # cache's recovered-close write lands (and stays uncommitted, since
        # apply_desktop_fallback alone — unlike prices_service.refresh_due_prices
        # — never commits it) right before the quota-state save's own fresh
        # session tries to write — the real collision, now entirely contained
        # to that throwaway session.
        result, _outcome = wiring.apply_desktop_fallback(
            ledger,
            cache,
            due=instruments_repo.list_instruments(ledger),
            now_utc=_NOW,
            today=_TODAY,
            primary_closes={},
            token="tok",
            fetch_closes_impl=_fake_tiingo,
        )

        # The recovered close still landed — it was written on the unaffected
        # `cache` session/connection, independent of the quota-state save's lock.
        assert result.get("VTI", 0) >= 1
        cache.commit()
        assert prices_repo.latest_price_dates(cache, [instr_id]).get(instr_id) == _TODAY

        # Neither the caller's `ledger` nor `cache` session was ever touched by
        # the failed save (it lives on its own connection) — this is the actual
        # regression: previously a failed save could poison a session shared
        # with the rest of the refresh and abort it via PendingRollbackError.
        ledger.commit()
    finally:
        ledger.close()
        cache.close()
        file_engine.dispose()


def test_cache_write_lock_does_not_poison_cache_session_or_abort_refresh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression test for the lock collision in the *other* direction.

    ``apply_desktop_fallback`` writes the recovered Tiingo closes + refresh
    stamp on ``cache`` with no guard of its own (unlike the quota-state save,
    which now has its own short-lived session). If that write collides with a
    lock — here simulated by an uncommitted write already sitting on
    ``ledger`` — the ``OperationalError`` propagates out of
    ``apply_desktop_fallback`` uncaught. ``prices_service._maybe_run_tiingo_fallback``
    catches it (to keep the primary yfinance result standing and report a
    friendly "local database was briefly locked" message), but must also roll
    ``cache`` back there, or the session is left in SQLAlchemy's "pending
    rollback" state for the rest of the tick — the commit when
    ``auto_refresh.tick_refresh``'s ``with`` block exits would then raise
    ``PendingRollbackError`` and abort the refresh, even though (thanks to the
    sibling fix) the primary yfinance closes were already durably committed
    before the fallback ever ran.

    Uses two real ``Session`` objects bound to one file-backed engine, same
    rationale as the sibling collision test above: the lock is the real,
    natural one between the two sessions' own uncommitted writes, not mocked.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from investment_dashboard.models import ALL_METADATAS
    from investment_dashboard.repositories import tiingo_state_repo as state_repo

    db_path = tmp_path / "wiring_reverse.sqlite"
    file_engine = create_engine(
        f"sqlite:///{db_path.as_posix()}", future=True, connect_args={"timeout": 0}
    )
    for md in ALL_METADATAS:
        md.create_all(file_engine)
    factory = sessionmaker(bind=file_engine, autoflush=False, expire_on_commit=False)
    ledger = factory()
    cache = factory()
    try:
        instr_id = _due_etf(ledger)
        state = state_repo.load(ledger, _NOW)
        state.stale_since["VTI"] = _NOW - timedelta(hours=2)
        state_repo.save(ledger, state)
        ledger.commit()  # committed so the separate `cache` connection can see it

        monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: "tok")

        def _fake_tiingo(symbols, start, end, *, token):
            return {s: {_TODAY: Decimal("123.45")} for s in symbols}

        monkeypatch.setattr(wiring.tiingo_client, "fetch_closes", _fake_tiingo)

        # Pre-seed `ledger` with an uncommitted write so `cache`'s recovered-close
        # write is the one that collides this time.
        price_cache_repo.upsert_last_refreshed_at(ledger, instr_id, _NOW)

        result: dict[str, int] = {}
        prices_service._maybe_run_tiingo_fallback(
            ledger,
            cache,
            due=instruments_repo.list_instruments(ledger),
            now=_NOW,
            today=_TODAY,
            primary_closes={},
            result=result,
        )

        # The refresh completed (no exception escaped) even though the Tiingo
        # write collided; nothing recovered this tick, so `result` is untouched.
        assert result == {}

        from investment_dashboard.services import runtime_status

        note = runtime_status.latest()
        assert note is not None
        assert "briefly locked" in note.message

        # Release `ledger`'s hold (it was only there to force the collision
        # above) so a follow-up write only fails if `cache` itself is still
        # broken, not because the file is still locked by something else.
        ledger.rollback()

        # `cache` must still be cleanly usable — the actual regression: before
        # the fix this session was left "pending rollback" and a later commit
        # (the scheduler's ``with cache_session_scope()`` exit) would raise
        # PendingRollbackError and abort the whole tick, regardless of whether
        # the lock itself had since cleared.
        price_cache_repo.upsert_last_refreshed_at(cache, instr_id, _NOW)
        cache.commit()
    finally:
        ledger.close()
        cache.close()
        file_engine.dispose()


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


def test_fallback_rate_limit_is_reported_as_credits(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A spent Tiingo quota (HTTP 429 → RateLimitedError) must read as "out of
    # credits", not the generic "unreachable" message, so the user doesn't go
    # Worker-hunting when they've simply burned the account's API budget.
    from investment_dashboard.adapters._retry import RateLimitedError
    from investment_dashboard.services import runtime_status

    _due_etf(session)
    monkeypatch.setattr(prices_service, "_resolve_tiingo_token", lambda: "tok")
    monkeypatch.setattr(
        wiring,
        "apply_desktop_fallback",
        lambda *a, **k: (_ for _ in ()).throw(RateLimitedError("HTTP 429 (rate limited)")),
    )

    prices_service.refresh_due_prices(session, today=_TODAY, now=_NOW)

    latest = runtime_status.latest()
    assert latest is not None
    assert not latest.is_warning
    assert "rate-limited" in latest.message
    assert "credits" in latest.message


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
