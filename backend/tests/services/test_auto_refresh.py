"""Tests for the user-editable auto-update interval (services.auto_refresh)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.services import auto_refresh


def test_interval_defaults_when_unset(session: Session) -> None:
    assert auto_refresh.get_interval_seconds(session) == auto_refresh.DEFAULT_INTERVAL_SECONDS


def test_interval_roundtrips_and_clamps(session: Session) -> None:
    # Normal value persists exactly.
    assert auto_refresh.set_interval_seconds(session, 120) == 120
    assert auto_refresh.get_interval_seconds(session) == 120
    # Below the floor clamps up.
    assert auto_refresh.set_interval_seconds(session, 1) == auto_refresh.MIN_INTERVAL_SECONDS
    # Above the ceiling clamps down.
    assert auto_refresh.set_interval_seconds(session, 99999) == auto_refresh.MAX_INTERVAL_SECONDS


def test_interval_ignores_corrupt_stored_value(session: Session) -> None:
    from investment_dashboard.repositories import app_config_repo

    app_config_repo.set_value(session, "live_refresh_interval_seconds", "not-a-number")
    assert auto_refresh.get_interval_seconds(session) == auto_refresh.DEFAULT_INTERVAL_SECONDS


def test_prefetched_answers_its_own_call_and_delegates_the_rest() -> None:
    from concurrent.futures import Future
    from datetime import date

    done: Future[dict[str, int]] = Future()
    done.set_result({"TWN": 1})
    seen: list[tuple[object, ...]] = []

    def fallback(symbols: list[str], start: date, end: date, **kwargs: object) -> str:
        seen.append((tuple(symbols), start, end, kwargs))
        return "fetched"

    key = (("TWN",), date(2026, 11, 20), date(2026, 11, 24))
    fetch = auto_refresh._Prefetched(key, done, fallback)
    assert fetch(["TWN"], date(2026, 11, 20), date(2026, 11, 24)) == {"TWN": 1}
    assert fetch(["TWN"], date(2025, 11, 20), date(2026, 11, 24)) == "fetched"
    assert fetch(["TWN"], date(2026, 11, 20), date(2026, 11, 24), adjusted=True) == "fetched"
    assert len(seen) == 2


def test_prefetched_reraises_a_failed_download() -> None:
    from concurrent.futures import Future
    from datetime import date

    import pytest

    failed: Future[object] = Future()
    failed.set_exception(RuntimeError("down"))
    fetch = auto_refresh._Prefetched(((), date(2026, 1, 1), date(2026, 1, 2)), failed, print)
    with pytest.raises(RuntimeError):
        fetch([], date(2026, 1, 1), date(2026, 1, 2))


def test_backfill_gate_runs_until_covered_then_rechecks(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from datetime import UTC, datetime, timedelta

    from investment_dashboard.services import intraday_snapshots_service as iss

    covered = {"day": True}
    monkeypatch.setattr(iss, "day_graph_covered", lambda _s, **_k: covered["day"])
    now = datetime(2026, 11, 23, 15, 30, tzinfo=UTC)
    auto_refresh.reset_backfill_gate()
    try:
        assert auto_refresh._backfill_due(now)  # never run yet
        auto_refresh._note_backfill(now, has_gaps=True)
        assert auto_refresh._backfill_due(now)  # still short of target
        auto_refresh._note_backfill(now, has_gaps=False)
        assert not auto_refresh._backfill_due(now + timedelta(minutes=1))
        covered["day"] = False  # the day's curve opened a hole
        assert auto_refresh._backfill_due(now + timedelta(minutes=1))
        covered["day"] = True
        assert auto_refresh._backfill_due(now + auto_refresh._BACKFILL_RECHECK)
        assert auto_refresh._backfill_due(now + timedelta(days=1))  # a new session
    finally:
        auto_refresh.reset_backfill_gate()
