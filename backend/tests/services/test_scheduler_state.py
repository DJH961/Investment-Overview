"""Scheduler state that must survive a restart (B-004, B-020), EOD failure
reporting (B-005) and the off-loop ``due()`` check (B-019). Fake data only."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard import db as db_module
from investment_dashboard.config import get_settings
from investment_dashboard.db import config_session_scope, dispose_engines, get_ledger_engine
from investment_dashboard.models import ALL_METADATAS
from investment_dashboard.services import app_config_service, scheduler
from investment_dashboard.services.live_bus import LiveBus
from investment_dashboard.services.scheduler import Jobs, Scheduler

ET = ZoneInfo("America/New_York")

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def _isolate_scheduler_state() -> None:
    """Override the autouse isolation: these tests use the real persistence."""


@pytest.fixture
def app_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    db = tmp_path / "app.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    db_module._dirty_state["since"] = None
    db_module._dirty_restored["done"] = False
    scheduler.reset_pauses_for_tests()
    try:
        yield db
    finally:
        dispose_engines()
        get_settings.cache_clear()
        db_module._dirty_state["since"] = None
        db_module._dirty_restored["done"] = False


def et(y: int, m: int, d: int, h: int, mi: int = 0) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=ET).astimezone(UTC)


def _sched(now: datetime, calls: list[str], eod_extra: dict[str, Any] | None = None) -> Scheduler:
    def eod() -> dict[str, Any] | None:
        calls.append("eod")
        return None if eod_extra is None else dict(eod_extra)

    sched = Scheduler(
        jobs=Jobs(
            tick=lambda: None,
            fx=lambda: None,
            eod=eod,
            interval_seconds=lambda: 60,
            fx_interval=lambda: timedelta(minutes=1),
            prices_due=lambda: False,
            backup_due=lambda _now: False,
        ),
        clock=lambda: now,
        bus=LiveBus(),
    )
    sched.state.last_fx = now
    sched.state.last_fx_ok = now
    return sched


async def test_last_eod_session_survives_a_restart(app_db: Path) -> None:
    now = et(2026, 11, 2, 16, 30)  # Monday after the close
    calls: list[str] = []
    first = _sched(now, calls)
    assert await first.step() == ["eod"]
    with config_session_scope() as cfg:
        assert app_config_service.get(cfg, scheduler.EOD_SESSION_KEY) == "2026-11-02"
    # A restart: a brand-new scheduler (empty in-memory state) must not re-run it.
    second = _sched(now, calls)
    assert await second.step() == []
    assert calls == ["eod"]


async def test_a_new_session_still_runs_eod_after_a_restart(app_db: Path) -> None:
    calls: list[str] = []
    await _sched(et(2026, 11, 2, 16, 30), calls).step()
    next_day = _sched(et(2026, 11, 3, 16, 30), calls)
    assert await next_day.step() == ["eod"]


async def test_failed_eod_step_sets_the_failure_flag_and_is_not_persisted(app_db: Path) -> None:
    now = et(2026, 11, 2, 16, 30)
    calls: list[str] = []
    sched = _sched(now, calls, eod_extra={scheduler.EOD_FAILED_STEPS: ["_refresh_prices"]})
    sub = sched.bus.subscribe()
    assert await sched.step() == ["eod"]
    eod = next(j for j in sched.snapshot()["jobs"] if j["name"] == "eod")
    assert eod["last_failed"] is True
    ev = await sub.get()
    assert ev["type"] == "refresh"
    assert scheduler.EOD_FAILED_STEPS not in ev
    with config_session_scope() as cfg:
        assert app_config_service.get(cfg, scheduler.EOD_SESSION_KEY) is None


def test_eod_job_reports_failed_steps(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard import boot

    for name in (
        "_refresh_live_fx",
        "_refresh_fx",
        "_refresh_prices",
        "_refresh_splits",
        "_refresh_benchmark",
        "_refresh_intraday_day",
        "_warm_snapshots",
        "_run_cache_janitor",
    ):
        monkeypatch.setattr(boot, name, lambda n=name: n != "_refresh_prices")
    assert scheduler.default_eod_job() == {scheduler.EOD_FAILED_STEPS: ["<lambda>"]}


def test_eod_job_clean_run_reports_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard import boot

    for name in (
        "_refresh_live_fx",
        "_refresh_fx",
        "_refresh_prices",
        "_refresh_splits",
        "_refresh_benchmark",
        "_refresh_intraday_day",
        "_warm_snapshots",
        "_run_cache_janitor",
    ):
        monkeypatch.setattr(boot, name, lambda: True)
    assert scheduler.default_eod_job() is None


async def test_due_runs_off_the_event_loop() -> None:
    now = et(2026, 11, 2, 16, 30)
    sched = _sched(now, [])
    seen: list[int] = []
    real_due = sched.due

    def spy(at: datetime, interval: int = 60) -> list[str]:
        seen.append(threading.get_ident())
        return real_due(at, interval)

    sched.due = spy  # type: ignore[method-assign]
    await sched.step()
    assert seen
    assert seen[0] != threading.get_ident()


def test_backup_dirty_marker_survives_a_restart(app_db: Path) -> None:
    db_module.mark_dirty()
    since = db_module.dirty_since()
    assert since is not None
    # Process restart: in-memory marker gone, the persisted copy re-arms it.
    db_module._dirty_state["since"] = None
    db_module._dirty_restored["done"] = False
    db_module.restore_dirty()
    assert db_module.dirty_since() == since
    # Clearing (a snapshot was sealed) removes the persisted copy too.
    db_module.clear_dirty()
    db_module._dirty_restored["done"] = False
    db_module.restore_dirty()
    assert db_module.dirty_since() is None


def test_persisting_the_marker_does_not_re_mark_the_database_dirty(app_db: Path) -> None:
    db_module.mark_dirty()
    db_module.clear_dirty()
    assert db_module.dirty_since() is None
